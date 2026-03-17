# Developer Guide

## Quick Start

```typescript
import { MemoryEngine, resolveLcmConfig } from "lossless-memory4agent";

// 1. Provide your own summarize function (any LLM)
const summarize = async (text: string, aggressive?: boolean) => {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Summarize the following conversation segment concisely." },
      { role: "user", content: text },
    ],
    max_tokens: aggressive ? 600 : 1200,
    temperature: aggressive ? 0.1 : 0.2,
  });
  return response.choices[0].message.content ?? "";
};

// 2. Create engine
const engine = new MemoryEngine({
  config: resolveLcmConfig(),
  summarize,
});

// 3. Create a conversation
const { conversationId } = await engine.createConversation("session-1");

// 4. Ingest messages
await engine.ingest({
  conversationId,
  sessionId: "session-1",
  message: { role: "user", content: "Hello, help me with my project" },
});

await engine.ingest({
  conversationId,
  sessionId: "session-1",
  message: { role: "assistant", content: "Sure! What are you working on?" },
});

// 5. Assemble context for the model (summaries + recent messages)
const context = await engine.assemble({
  conversationId,
  tokenBudget: 8000,
});
// context.messages — ordered array ready for model input
// context.estimatedTokens — total estimated tokens
// context.systemPromptAddition — optional LCM guidance for the model

// 6. Compact when needed
await engine.compact({
  conversationId,
  tokenBudget: 8000,
});

// 7. Search memory
const results = await engine.grep({
  query: "project",
  mode: "full_text",
  scope: "both",
});

// 8. Inspect a summary
const detail = await engine.describe("sum_abc123def456");

// 9. Expand a summary to its children
const expanded = await engine.expand({
  summaryId: "sum_abc123def456",
  depth: 2,
  includeMessages: true,
});

// 10. Cleanup
await engine.dispose();
```

## Using Custom Prompts

The SDK exports prompt builders so you can use the battle-tested LCM prompts with your own LLM:

```typescript
import {
  buildLeafSummaryPrompt,
  buildCondensedSummaryPrompt,
  LCM_SUMMARIZER_SYSTEM_PROMPT,
  resolveTargetTokens,
  estimateTokens,
} from "lossless-memory4agent";

const summarize = async (text, aggressive, options) => {
  const mode = aggressive ? "aggressive" : "normal";
  const isCondensed = options?.isCondensed === true;
  const targetTokens = resolveTargetTokens({
    inputTokens: estimateTokens(text),
    mode,
    isCondensed,
    condensedTargetTokens: 2000,
  });

  const prompt = isCondensed
    ? buildCondensedSummaryPrompt({
        text,
        targetTokens,
        depth: options?.depth ?? 1,
        previousSummary: options?.previousSummary,
      })
    : buildLeafSummaryPrompt({
        text,
        mode,
        targetTokens,
        previousSummary: options?.previousSummary,
      });

  const response = await yourLLM({
    system: LCM_SUMMARIZER_SYSTEM_PROMPT,
    prompt,
    maxTokens: targetTokens,
    temperature: aggressive ? 0.1 : 0.2,
  });

  return response.text;
};
```

## Integration Patterns

### With OpenAI Agent SDK

```typescript
import { MemoryEngine, resolveLcmConfig } from "lossless-memory4agent";
import OpenAI from "openai";

const openai = new OpenAI();
const engine = new MemoryEngine({
  config: resolveLcmConfig(),
  summarize: async (text, aggressive) => {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Summarize concisely." },
        { role: "user", content: text },
      ],
      max_tokens: aggressive ? 600 : 1200,
    });
    return res.choices[0].message.content ?? "";
  },
});

// In your agent loop:
// 1. Before each turn: assemble context
// 2. After each turn: ingest messages + compact if needed
```

### With Anthropic Claude

```typescript
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();
const engine = new MemoryEngine({
  config: resolveLcmConfig(),
  summarize: async (text, aggressive) => {
    const res = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: aggressive ? 600 : 1200,
      system: "Summarize concisely.",
      messages: [{ role: "user", content: text }],
    });
    const block = res.content[0];
    return block.type === "text" ? block.text : "";
  },
});
```

### Generic Agent Loop

```typescript
async function agentLoop(engine, conversationId, tokenBudget) {
  while (true) {
    const userInput = await getUserInput();
    if (!userInput) break;

    // Ingest user message
    await engine.ingest({
      conversationId,
      sessionId: "main",
      message: { role: "user", content: userInput },
    });

    // Assemble context
    const ctx = await engine.assemble({ conversationId, tokenBudget });

    // Call LLM with assembled context
    const response = await callLLM(ctx.messages, ctx.systemPromptAddition);

    // Ingest assistant response
    await engine.ingest({
      conversationId,
      sessionId: "main",
      message: { role: "assistant", content: response },
    });

    // Compact if needed
    await engine.compact({ conversationId, tokenBudget });

    console.log(response);
  }
}
```

## API Reference

### `MemoryEngine`

#### Constructor
```typescript
new MemoryEngine(deps: MemoryDependencies)
```

- `deps.config` — `LcmConfig` from `resolveLcmConfig()`
- `deps.summarize` — `LcmSummarizeFn` callback (your LLM)
- `deps.log` — optional logger

#### Methods

| Method | Description |
|--------|-------------|
| `createConversation(sessionId)` | Create/get a conversation, returns `{ conversationId }` |
| `ingest({ conversationId, sessionId, message })` | Store a message |
| `ingestBatch({ conversationId, sessionId, messages })` | Store multiple messages |
| `assemble({ conversationId, tokenBudget, freshTailCount? })` | Build model context |
| `compact({ conversationId, tokenBudget, force? })` | Run compaction |
| `grep(input)` | Search messages and summaries |
| `describe(id)` | Inspect a summary or file by ID |
| `expand(input)` | Traverse DAG children |
| `dispose()` | Close database connection |

### `MemoryMessage`

```typescript
type MemoryMessage = {
  role: "user" | "assistant" | "system" | "tool" | "toolResult";
  content: unknown;       // string or content block array
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};
```

### `GrepInput`

```typescript
interface GrepInput {
  query: string;
  mode: "regex" | "full_text";
  scope: "messages" | "summaries" | "both";
  conversationId?: number;
  since?: Date;
  before?: Date;
  limit?: number;
}
```

### `ExpandInput`

```typescript
interface ExpandInput {
  summaryId: string;
  depth?: number;            // default 1
  includeMessages?: boolean; // include source messages at leaf level
  tokenCap?: number;         // max tokens before truncation
}
```
