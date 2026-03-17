import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ContextAssembler } from "./assembler.js";
import { CompactionEngine, type CompactionConfig } from "./compaction.js";
import type { LcmConfig } from "./db/config.js";
import { getLcmConnection, closeLcmConnection } from "./db/connection.js";
import { getLcmDbFeatures } from "./db/features.js";
import { runLcmMigrations } from "./db/migration.js";
import {
  extensionFromNameOrMime,
  formatFileReference,
  generateExplorationSummary,
  parseFileBlocks,
} from "./large-files.js";
import { RetrievalEngine } from "./retrieval.js";
import type { GrepInput, GrepResult, DescribeResult, ExpandInput, ExpandResult } from "./retrieval.js";
import {
  ConversationStore,
  type CreateMessagePartInput,
  type MessagePartType,
} from "./store/conversation-store.js";
import { SummaryStore } from "./store/summary-store.js";
import type { LcmSummarizeFn } from "./summarize.js";
import type { MemoryDependencies, MemoryMessage } from "./types.js";

// ── Re-exports for convenience ──────────────────────────────────────────────

export type { GrepInput, GrepResult, DescribeResult, ExpandInput, ExpandResult };
export type { MemoryMessage };

// ── Result types ────────────────────────────────────────────────────────────

export interface IngestResult {
  ingested: boolean;
}

export interface AssembleResult {
  messages: MemoryMessage[];
  estimatedTokens: number;
  systemPromptAddition?: string;
  stats: {
    rawMessageCount: number;
    summaryCount: number;
    totalContextItems: number;
  };
}

export interface CompactResult {
  ok: boolean;
  compacted: boolean;
  reason: string;
  result?: {
    tokensBefore: number;
    tokensAfter?: number;
    details?: {
      rounds: number;
      targetTokens?: number;
    };
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function toJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  return typeof encoded === "string" ? encoded : "";
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function appendTextValue(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      appendTextValue(entry, out);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  appendTextValue(record.text, out);
  appendTextValue(record.value, out);
}

function extractReasoningText(record: Record<string, unknown>): string | undefined {
  const chunks: string[] = [];
  appendTextValue(record.summary, chunks);
  if (chunks.length === 0) {
    return undefined;
  }
  const normalized = chunks
    .map((chunk) => chunk.trim())
    .filter((chunk, idx, arr) => chunk.length > 0 && arr.indexOf(chunk) === idx);
  return normalized.length > 0 ? normalized.join("\n") : undefined;
}

function normalizeUnknownBlock(value: unknown): {
  type: string;
  text?: string;
  metadata: Record<string, unknown>;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      type: "agent",
      metadata: { raw: value },
    };
  }

  const record = value as Record<string, unknown>;
  const rawType = safeString(record.type);
  return {
    type: rawType ?? "agent",
    text:
      safeString(record.text) ??
      safeString(record.thinking) ??
      ((rawType === "reasoning" || rawType === "thinking")
        ? extractReasoningText(record)
        : undefined),
    metadata: { raw: record },
  };
}

function toPartType(type: string): MessagePartType {
  switch (type) {
    case "text":
      return "text";
    case "thinking":
    case "reasoning":
      return "reasoning";
    case "tool_use":
    case "toolUse":
    case "tool-use":
    case "toolCall":
    case "functionCall":
    case "function_call":
    case "function_call_output":
    case "tool_result":
    case "toolResult":
    case "tool":
      return "tool";
    case "patch":
      return "patch";
    case "file":
    case "image":
      return "file";
    case "subtask":
      return "subtask";
    case "compaction":
      return "compaction";
    case "step_start":
    case "step-start":
      return "step_start";
    case "step_finish":
    case "step-finish":
      return "step_finish";
    case "snapshot":
      return "snapshot";
    case "retry":
      return "retry";
    case "agent":
      return "agent";
    default:
      return "agent";
  }
}

function extractMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type?: unknown; text?: unknown } => {
        return !!block && typeof block === "object";
      })
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("\n");
  }
  const serialized = JSON.stringify(content);
  return typeof serialized === "string" ? serialized : "";
}

function toRuntimeRoleForTokenEstimate(role: string): "user" | "assistant" | "toolResult" {
  if (role === "tool" || role === "toolResult") {
    return "toolResult";
  }
  if (role === "user" || role === "system") {
    return "user";
  }
  return "assistant";
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.type === "text" && typeof record.text === "string";
}

function estimateContentTokensForRole(params: {
  role: "user" | "assistant" | "toolResult";
  content: unknown;
  fallbackContent: string;
}): number {
  const { role, content, fallbackContent } = params;
  if (typeof content === "string") {
    return estimateTokens(content);
  }
  if (Array.isArray(content)) {
    if (content.length === 0) {
      return estimateTokens(fallbackContent);
    }
    if (role === "user" && content.length === 1 && isTextBlock(content[0])) {
      return estimateTokens(content[0].text);
    }
    const serialized = JSON.stringify(content);
    return estimateTokens(typeof serialized === "string" ? serialized : "");
  }
  if (content && typeof content === "object") {
    if (role === "user" && isTextBlock(content)) {
      return estimateTokens(content.text);
    }
    const serialized = JSON.stringify([content]);
    return estimateTokens(typeof serialized === "string" ? serialized : "");
  }
  return estimateTokens(fallbackContent);
}

function buildMessageParts(params: {
  sessionId: string;
  message: MemoryMessage;
  fallbackContent: string;
}): CreateMessagePartInput[] {
  const { sessionId, message, fallbackContent } = params;
  const role = typeof message.role === "string" ? message.role : "unknown";
  const topLevel = message as unknown as Record<string, unknown>;
  const topLevelToolCallId =
    safeString(topLevel.toolCallId) ??
    safeString(topLevel.tool_call_id) ??
    safeString(topLevel.toolUseId) ??
    safeString(topLevel.tool_use_id) ??
    safeString(topLevel.call_id) ??
    safeString(topLevel.id);
  const topLevelToolName =
    safeString(topLevel.toolName) ??
    safeString(topLevel.tool_name);
  const topLevelIsError =
    safeBoolean(topLevel.isError) ??
    safeBoolean(topLevel.is_error);

  if (typeof message.content === "string") {
    return [
      {
        sessionId,
        partType: "text",
        ordinal: 0,
        textContent: message.content,
        metadata: toJson({
          originalRole: role,
          toolCallId: topLevelToolCallId,
          toolName: topLevelToolName,
          isError: topLevelIsError,
        }),
      },
    ];
  }

  if (!Array.isArray(message.content)) {
    return [
      {
        sessionId,
        partType: "agent",
        ordinal: 0,
        textContent: fallbackContent || null,
        metadata: toJson({
          originalRole: role,
          source: "non-array-content",
          raw: message.content,
        }),
      },
    ];
  }

  const parts: CreateMessagePartInput[] = [];
  for (let ordinal = 0; ordinal < message.content.length; ordinal++) {
    const block = normalizeUnknownBlock(message.content[ordinal]);
    const metadataRecord = block.metadata.raw as Record<string, unknown> | undefined;
    const partType = toPartType(block.type);
    const toolCallId =
      safeString(metadataRecord?.toolCallId) ??
      safeString(metadataRecord?.tool_call_id) ??
      safeString(metadataRecord?.toolUseId) ??
      safeString(metadataRecord?.tool_use_id) ??
      safeString(metadataRecord?.call_id) ??
      (partType === "tool" ? safeString(metadataRecord?.id) : undefined) ??
      topLevelToolCallId;

    parts.push({
      sessionId,
      partType,
      ordinal,
      textContent: block.text ?? null,
      toolCallId,
      toolName:
        safeString(metadataRecord?.name) ??
        safeString(metadataRecord?.toolName) ??
        safeString(metadataRecord?.tool_name) ??
        topLevelToolName,
      toolInput:
        metadataRecord?.input !== undefined
          ? toJson(metadataRecord.input)
          : metadataRecord?.arguments !== undefined
            ? toJson(metadataRecord.arguments)
          : metadataRecord?.toolInput !== undefined
            ? toJson(metadataRecord.toolInput)
            : (safeString(metadataRecord?.tool_input) ?? null),
      toolOutput:
        metadataRecord?.output !== undefined
          ? toJson(metadataRecord.output)
          : metadataRecord?.toolOutput !== undefined
            ? toJson(metadataRecord.toolOutput)
            : (safeString(metadataRecord?.tool_output) ?? null),
      metadata: toJson({
        originalRole: role,
        toolCallId: topLevelToolCallId,
        toolName: topLevelToolName,
        isError: topLevelIsError,
        rawType: block.type,
        raw: metadataRecord ?? message.content[ordinal],
      }),
    });
  }

  return parts;
}

function toDbRole(role: string): "user" | "assistant" | "system" | "tool" {
  if (role === "tool" || role === "toolResult") {
    return "tool";
  }
  if (role === "system") {
    return "system";
  }
  if (role === "user") {
    return "user";
  }
  if (role === "assistant") {
    return "assistant";
  }
  return "assistant";
}

type StoredMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tokenCount: number;
};

function toStoredMessage(message: MemoryMessage): StoredMessage {
  const content = extractMessageContent(message.content);
  const runtimeRole = toRuntimeRoleForTokenEstimate(message.role);
  const tokenCount = estimateContentTokensForRole({
    role: runtimeRole,
    content: message.content,
    fallbackContent: content,
  });

  return {
    role: toDbRole(message.role),
    content,
    tokenCount,
  };
}

// ── MemoryEngine ────────────────────────────────────────────────────────────

export class MemoryEngine {
  private config: LcmConfig;
  private conversationStore: ConversationStore;
  private summaryStore: SummaryStore;
  private assembler: ContextAssembler;
  private compaction: CompactionEngine;
  private retrieval: RetrievalEngine;
  private migrated = false;
  private readonly fts5Available: boolean;
  private sessionOperationQueues = new Map<string, Promise<void>>();
  private summarize: LcmSummarizeFn;
  private log: MemoryDependencies["log"];

  get timezone(): string {
    return this.config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  constructor(deps: MemoryDependencies) {
    this.config = deps.config;
    this.summarize = deps.summarize;
    this.log = deps.log ?? {
      info: (msg: string) => console.log(msg),
      warn: (msg: string) => console.warn(msg),
      error: (msg: string) => console.error(msg),
      debug: () => {},
    };

    const db = getLcmConnection(this.config.databasePath);
    this.fts5Available = getLcmDbFeatures(db).fts5Available;

    this.conversationStore = new ConversationStore(db, { fts5Available: this.fts5Available });
    this.summaryStore = new SummaryStore(db, { fts5Available: this.fts5Available });

    if (!this.fts5Available) {
      this.log.warn!(
        "[lcm] FTS5 unavailable in the current Node runtime; full_text search will fall back to LIKE",
      );
    }

    this.assembler = new ContextAssembler(
      this.conversationStore,
      this.summaryStore,
      this.config.timezone,
    );

    const compactionConfig: CompactionConfig = {
      contextThreshold: this.config.contextThreshold,
      freshTailCount: this.config.freshTailCount,
      leafMinFanout: this.config.leafMinFanout,
      condensedMinFanout: this.config.condensedMinFanout,
      condensedMinFanoutHard: this.config.condensedMinFanoutHard,
      incrementalMaxDepth: this.config.incrementalMaxDepth,
      leafChunkTokens: this.config.leafChunkTokens,
      leafTargetTokens: this.config.leafTargetTokens,
      condensedTargetTokens: this.config.condensedTargetTokens,
      maxRounds: 10,
      timezone: this.config.timezone,
    };
    this.compaction = new CompactionEngine(
      this.conversationStore,
      this.summaryStore,
      compactionConfig,
    );

    this.retrieval = new RetrievalEngine(this.conversationStore, this.summaryStore);
  }

  private ensureMigrated(): void {
    if (this.migrated) {
      return;
    }
    const db = getLcmConnection(this.config.databasePath);
    runLcmMigrations(db, { fts5Available: this.fts5Available });
    this.migrated = true;
  }

  private async withQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionOperationQueues.get(key) ?? Promise.resolve();
    let releaseQueue: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const next = previous.catch(() => {}).then(() => current);
    this.sessionOperationQueues.set(key, next);

    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      releaseQueue();
      void next.finally(() => {
        if (this.sessionOperationQueues.get(key) === next) {
          this.sessionOperationQueues.delete(key);
        }
      });
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Create a new conversation. Returns its ID for use in other methods.
   */
  async createConversation(sessionId: string): Promise<{ conversationId: number }> {
    this.ensureMigrated();
    const conversation = await this.conversationStore.getOrCreateConversation(sessionId);
    return { conversationId: conversation.conversationId };
  }

  /**
   * Store a message in a conversation.
   */
  async ingest(params: {
    conversationId: number;
    sessionId: string;
    message: MemoryMessage;
  }): Promise<IngestResult> {
    this.ensureMigrated();
    const key = String(params.conversationId);
    return this.withQueue(key, () => this.ingestSingle(params));
  }

  /**
   * Store multiple messages in a conversation.
   */
  async ingestBatch(params: {
    conversationId: number;
    sessionId: string;
    messages: MemoryMessage[];
  }): Promise<{ ingestedCount: number }> {
    this.ensureMigrated();
    if (params.messages.length === 0) {
      return { ingestedCount: 0 };
    }
    const key = String(params.conversationId);
    return this.withQueue(key, async () => {
      let ingestedCount = 0;
      for (const message of params.messages) {
        const result = await this.ingestSingle({
          conversationId: params.conversationId,
          sessionId: params.sessionId,
          message,
        });
        if (result.ingested) {
          ingestedCount += 1;
        }
      }
      return { ingestedCount };
    });
  }

  /**
   * Assemble context under a token budget.
   * Returns summaries + recent messages ordered chronologically.
   */
  async assemble(params: {
    conversationId: number;
    tokenBudget: number;
    freshTailCount?: number;
  }): Promise<AssembleResult> {
    this.ensureMigrated();
    const { conversationId, tokenBudget } = params;

    const assembled = await this.assembler.assemble({
      conversationId,
      tokenBudget,
      freshTailCount: params.freshTailCount ?? this.config.freshTailCount,
    });

    return {
      messages: assembled.messages as MemoryMessage[],
      estimatedTokens: assembled.estimatedTokens,
      systemPromptAddition: assembled.systemPromptAddition,
      stats: assembled.stats,
    };
  }

  /**
   * Run compaction on a conversation.
   */
  async compact(params: {
    conversationId: number;
    tokenBudget: number;
    force?: boolean;
  }): Promise<CompactResult> {
    this.ensureMigrated();
    const { conversationId, tokenBudget, force = false } = params;
    const key = String(conversationId);

    return this.withQueue(key, async () => {
      const decision = await this.compaction.evaluate(conversationId, tokenBudget);

      if (!force && !decision.shouldCompact) {
        return {
          ok: true,
          compacted: false,
          reason: "below threshold",
          result: { tokensBefore: decision.currentTokens },
        };
      }

      const sweepResult = await this.compaction.compactFullSweep({
        conversationId,
        tokenBudget,
        summarize: this.summarize,
        force,
        hardTrigger: false,
      });

      return {
        ok: true,
        compacted: sweepResult.actionTaken,
        reason: sweepResult.actionTaken ? "compacted" : "nothing to compact",
        result: {
          tokensBefore: decision.currentTokens,
          tokensAfter: sweepResult.tokensAfter,
          details: {
            rounds: sweepResult.actionTaken ? 1 : 0,
            targetTokens: tokenBudget,
          },
        },
      };
    });
  }

  /**
   * Search messages and summaries.
   */
  async grep(input: GrepInput): Promise<GrepResult> {
    this.ensureMigrated();
    return this.retrieval.grep(input);
  }

  /**
   * Describe a summary or file by ID.
   */
  async describe(id: string): Promise<DescribeResult | null> {
    this.ensureMigrated();
    return this.retrieval.describe(id);
  }

  /**
   * Expand a summary to its children and/or source messages.
   */
  async expand(input: ExpandInput): Promise<ExpandResult> {
    this.ensureMigrated();
    return this.retrieval.expand(input);
  }

  /**
   * Close the database connection.
   */
  async dispose(): Promise<void> {
    closeLcmConnection(this.config.databasePath);
  }

  // ── Accessors ─────────────────────────────────────────────────────────

  getRetrieval(): RetrievalEngine {
    return this.retrieval;
  }

  getConversationStore(): ConversationStore {
    return this.conversationStore;
  }

  getSummaryStore(): SummaryStore {
    return this.summaryStore;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private async ingestSingle(params: {
    conversationId: number;
    sessionId: string;
    message: MemoryMessage;
  }): Promise<IngestResult> {
    const { conversationId, sessionId, message } = params;
    const stored = toStoredMessage(message);

    let messageForParts = message;
    if (stored.role === "user") {
      const intercepted = await this.interceptLargeFiles({
        conversationId,
        content: stored.content,
      });
      if (intercepted) {
        stored.content = intercepted.rewrittenContent;
        stored.tokenCount = estimateTokens(stored.content);
        messageForParts = {
          ...message,
          content: stored.content,
        };
      }
    }

    const maxSeq = await this.conversationStore.getMaxSeq(conversationId);
    const seq = maxSeq + 1;

    const msgRecord = await this.conversationStore.createMessage({
      conversationId,
      seq,
      role: stored.role,
      content: stored.content,
      tokenCount: stored.tokenCount,
    });
    await this.conversationStore.createMessageParts(
      msgRecord.messageId,
      buildMessageParts({
        sessionId,
        message: messageForParts,
        fallbackContent: stored.content,
      }),
    );

    await this.summaryStore.appendContextMessage(conversationId, msgRecord.messageId);
    return { ingested: true };
  }

  private async storeLargeFileContent(params: {
    conversationId: number;
    fileId: string;
    extension: string;
    content: string;
  }): Promise<string> {
    const dir = join(homedir(), ".lossless-memory", "lcm-files", String(params.conversationId));
    await mkdir(dir, { recursive: true });

    const normalizedExtension = params.extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "txt";
    const filePath = join(dir, `${params.fileId}.${normalizedExtension}`);
    await writeFile(filePath, params.content, "utf8");
    return filePath;
  }

  private async interceptLargeFiles(params: {
    conversationId: number;
    content: string;
  }): Promise<{ rewrittenContent: string; fileIds: string[] } | null> {
    const blocks = parseFileBlocks(params.content);
    if (blocks.length === 0) {
      return null;
    }

    const threshold = Math.max(1, this.config.largeFileTokenThreshold);
    const fileIds: string[] = [];
    const rewrittenSegments: string[] = [];
    let cursor = 0;
    let interceptedAny = false;

    for (const block of blocks) {
      const blockTokens = estimateTokens(block.text);
      if (blockTokens < threshold) {
        continue;
      }

      interceptedAny = true;
      const fileId = `file_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const extension = extensionFromNameOrMime(block.fileName, block.mimeType);
      const storageUri = await this.storeLargeFileContent({
        conversationId: params.conversationId,
        fileId,
        extension,
        content: block.text,
      });
      const byteSize = Buffer.byteLength(block.text, "utf8");
      const explorationSummary = await generateExplorationSummary({
        content: block.text,
        fileName: block.fileName,
        mimeType: block.mimeType,
      });

      await this.summaryStore.insertLargeFile({
        fileId,
        conversationId: params.conversationId,
        fileName: block.fileName,
        mimeType: block.mimeType,
        byteSize,
        storageUri,
        explorationSummary,
      });

      rewrittenSegments.push(params.content.slice(cursor, block.start));
      rewrittenSegments.push(
        formatFileReference({
          fileId,
          fileName: block.fileName,
          mimeType: block.mimeType,
          byteSize,
          summary: explorationSummary,
        }),
      );
      cursor = block.end;
      fileIds.push(fileId);
    }

    if (!interceptedAny) {
      return null;
    }

    rewrittenSegments.push(params.content.slice(cursor));
    return {
      rewrittenContent: rewrittenSegments.join(""),
      fileIds,
    };
  }
}
