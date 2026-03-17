/**
 * lossless-memory4agent — DAG-based long-term memory management for AI agents.
 *
 * Standalone SDK with no framework dependencies. Provide a summarize callback
 * and get persistent, hierarchically compacted conversation memory.
 */

// Core engine
export { MemoryEngine } from "./src/engine.js";
export type {
  IngestResult,
  AssembleResult,
  CompactResult,
  MemoryMessage,
  GrepInput,
  GrepResult,
  DescribeResult,
  ExpandInput,
  ExpandResult,
} from "./src/engine.js";

// Types & config
export type { MemoryDependencies } from "./src/types.js";
export type { LcmConfig } from "./src/db/config.js";
export { resolveLcmConfig } from "./src/db/config.js";

// Summarization (prompt builders for hosts that want to customize)
export type { LcmSummarizeFn, LcmSummarizeOptions } from "./src/summarize.js";
export {
  LCM_SUMMARIZER_SYSTEM_PROMPT,
  buildLeafSummaryPrompt,
  buildCondensedSummaryPrompt,
  buildDeterministicFallbackSummary,
  estimateTokens,
  resolveTargetTokens,
} from "./src/summarize.js";

// Integrity & metrics
export { IntegrityChecker, collectMetrics } from "./src/integrity.js";
export type { IntegrityReport, LcmMetrics } from "./src/integrity.js";

// Retrieval engine (for advanced use)
export { RetrievalEngine } from "./src/retrieval.js";

// Store layer (for advanced use)
export { ConversationStore } from "./src/store/conversation-store.js";
export { SummaryStore } from "./src/store/summary-store.js";
