# lossless-memory4agent

> **Fork Notice**: This project is forked from [Martian-Engineering/lossless-claw](https://github.com/Martian-Engineering/lossless-claw) and refactored into a **standalone, framework-agnostic long-term memory SDK** for AI agents. All OpenClaw plugin coupling, sub-agent expansion system, and framework-specific dependencies have been removed. The core DAG-based summarization engine is preserved intact.
>
> **Author**: Hor1zonZzz (461986128@qq.com)
>
> **Original Author**: Josh Lehman (josh@martian.engineering), [Martian Engineering](https://github.com/Martian-Engineering)

---

## What is this?

A DAG-based long-term memory management library for AI agents. It persists every conversation message in SQLite, automatically summarizes old messages into a hierarchical DAG structure, and provides retrieval methods to search and recall details — **without losing any information**.

It works with **any LLM provider** and **any agent framework**. You just provide a `summarize` callback.

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

// 2. Create engine (zero runtime dependencies, only node:sqlite)
const engine = new MemoryEngine({
  config: resolveLcmConfig(),
  summarize,
});

// 3. Create a conversation
const { conversationId } = await engine.createConversation("session-1");

// 4. Store messages
await engine.ingest({
  conversationId,
  sessionId: "session-1",
  message: { role: "user", content: "Help me refactor the auth module" },
});
await engine.ingest({
  conversationId,
  sessionId: "session-1",
  message: { role: "assistant", content: "Sure, let me look at the current implementation..." },
});

// 5. Assemble context (summaries + recent messages, within token budget)
const context = await engine.assemble({
  conversationId,
  tokenBudget: 8000,
});
// context.messages — ready for model input
// context.systemPromptAddition — optional DAG-aware guidance

// 6. Compact when needed
await engine.compact({ conversationId, tokenBudget: 8000 });

// 7. Search memory
const results = await engine.grep({
  query: "auth module",
  mode: "full_text",
  scope: "both",
});

// 8. Inspect or expand a summary
const detail = await engine.describe("sum_abc123");
const expanded = await engine.expand({
  summaryId: "sum_abc123",
  depth: 2,
  includeMessages: true,
});

// 9. Cleanup
await engine.dispose();
```

## API

| Method | Description |
|--------|-------------|
| `createConversation(sessionId)` | Create or get a conversation |
| `ingest({ conversationId, sessionId, message })` | Store a message |
| `ingestBatch({ conversationId, sessionId, messages })` | Store multiple messages |
| `assemble({ conversationId, tokenBudget })` | Build model context from summaries + recent messages |
| `compact({ conversationId, tokenBudget })` | Run DAG compaction |
| `grep({ query, mode, scope })` | Search messages and summaries (FTS5 or regex) |
| `describe(id)` | Inspect a summary or large file by ID |
| `expand({ summaryId, depth })` | Traverse DAG to retrieve children and source messages |
| `dispose()` | Close database connection |

## How It Works

When a conversation grows beyond the token budget:

1. **Persists every message** in SQLite, organized by conversation
2. **Summarizes chunks** (~20k tokens → ~1200 token leaf summary) using your LLM
3. **Condenses summaries** hierarchically into higher-level DAG nodes as they accumulate
4. **Assembles context** each turn: summaries (old) + raw messages (recent) within budget
5. **Provides retrieval** — `grep()`, `describe()`, `expand()` to drill into compacted history

Nothing is lost. Raw messages stay in the database. Any summary can be expanded back to its source messages.

```
[Raw Messages 1-20] → Leaf 0 ─┐
[Raw Messages 21-40] → Leaf 1 ─┼→ Condensed d1 ─┐
[Raw Messages 41-60] → Leaf 2 ─┘                 ├→ Condensed d2
[Raw Messages 61-80] → Leaf 3 ─┐                 │
[Raw Messages 81-100] → Leaf 4 ┼→ Condensed d1 ─┘
                                │
                    [Recent messages 101-132: always kept raw]
```

## Integration Examples

### With OpenAI

```typescript
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

### Using Built-in Prompt Builders

The SDK exports the battle-tested LCM prompt templates for customization:

```typescript
import {
  buildLeafSummaryPrompt,
  buildCondensedSummaryPrompt,
  LCM_SUMMARIZER_SYSTEM_PROMPT,
  resolveTargetTokens,
  estimateTokens,
} from "lossless-memory4agent";
```

## Configuration

Configuration is resolved with three-tier precedence: env vars > config object > defaults.

```typescript
const config = resolveLcmConfig(process.env, {
  contextThreshold: 0.8,      // trigger compaction at 80%
  freshTailCount: 16,          // keep last 16 messages raw
  databasePath: "./memory.db", // custom DB path
});
```

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `databasePath` | `LCM_DATABASE_PATH` | `~/.lossless-memory/lcm.db` | SQLite database path |
| `contextThreshold` | `LCM_CONTEXT_THRESHOLD` | `0.75` | Fraction of budget that triggers compaction |
| `freshTailCount` | `LCM_FRESH_TAIL_COUNT` | `32` | Recent messages always kept raw |
| `leafMinFanout` | `LCM_LEAF_MIN_FANOUT` | `8` | Min raw messages per leaf summary |
| `condensedMinFanout` | `LCM_CONDENSED_MIN_FANOUT` | `4` | Min summaries per condensed node |
| `leafChunkTokens` | `LCM_LEAF_CHUNK_TOKENS` | `20000` | Max source tokens per leaf chunk |
| `leafTargetTokens` | `LCM_LEAF_TARGET_TOKENS` | `1200` | Target leaf summary size |
| `condensedTargetTokens` | `LCM_CONDENSED_TARGET_TOKENS` | `2000` | Target condensed summary size |
| `largeFileTokenThreshold` | `LCM_LARGE_FILE_TOKEN_THRESHOLD` | `25000` | Threshold for large file interception |

See [docs/configuration.md](docs/configuration.md) for full reference.

## Documentation

- [Developer Guide](docs/guide.md) — full API reference and integration patterns
- [Architecture](docs/architecture.md) — DAG data model, compaction lifecycle, module structure
- [Configuration](docs/configuration.md) — all options and tuning guidelines
- [FTS5 Setup](docs/fts5.md) — full-text search configuration

## Project Structure

```
index.ts                    # SDK entry point — public exports
src/
  engine.ts                 # MemoryEngine — main class
  assembler.ts              # Context assembly (summaries + messages → model context)
  compaction.ts             # CompactionEngine — leaf passes, condensation, sweeps
  summarize.ts              # Depth-aware prompt builders (exported for customization)
  retrieval.ts              # RetrievalEngine — grep, describe, expand
  large-files.ts            # Large file interception and exploration summaries
  integrity.ts              # DAG integrity checks and metrics
  transcript-repair.ts      # Tool-use/result pairing sanitization
  types.ts                  # MemoryMessage, MemoryDependencies
  db/
    config.ts               # LcmConfig resolution (env vars + config object)
    connection.ts           # SQLite connection management (WAL mode)
    migration.ts            # Schema migrations
    features.ts             # Runtime feature detection (FTS5)
  store/
    conversation-store.ts   # Message persistence and retrieval
    summary-store.ts        # Summary DAG persistence
    fts5-sanitize.ts        # FTS5 query sanitization
    full-text-fallback.ts   # LIKE-based search fallback
docs/                       # Documentation
tui/                        # Interactive terminal UI for DB inspection (Go, from upstream)
```

## Requirements

- **Node.js 22+** (for built-in `node:sqlite`)
- Zero runtime dependencies

## Changes from Upstream (lossless-claw)

- Removed all OpenClaw plugin coupling (`ContextEngine` interface, plugin manifest, bridge)
- Removed sub-agent expansion system (`expansion-auth`, `expansion-policy`, `lcm_expand_query`)
- Removed tool definitions (`src/tools/` — functionality exposed as `MemoryEngine` methods)
- Removed dependencies: `openclaw`, `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, `@sinclair/typebox`
- New `MemoryEngine` class with simple function-oriented API
- Summarization is now a user-provided callback (framework-agnostic)
- Default database path changed from `~/.openclaw/lcm.db` to `~/.lossless-memory/lcm.db`
- Prompt builders exported for host customization

Core DAG compaction, assembly, retrieval, and storage layers are preserved unchanged.

## License

MIT

---

<details>
<summary><strong>Original README (lossless-claw)</strong></summary>

# lossless-claw

Lossless Context Management plugin for [OpenClaw](https://github.com/openclaw/openclaw), based on the [LCM paper](https://papers.voltropy.com/LCM) from [Voltropy](https://x.com/Voltropy). Replaces OpenClaw's built-in sliding-window compaction with a DAG-based summarization system that preserves every message while keeping active context within model token limits.

## What it does

Two ways to learn: read the below, or [check out this super cool animated visualization](https://losslesscontext.ai).

When a conversation grows beyond the model's context window, OpenClaw (just like all of the other agents) normally truncates older messages. LCM instead:

1. **Persists every message** in a SQLite database, organized by conversation
2. **Summarizes chunks** of older messages into summaries using your configured LLM
3. **Condenses summaries** into higher-level nodes as they accumulate, forming a DAG (directed acyclic graph)
4. **Assembles context** each turn by combining summaries + recent raw messages
5. **Provides tools** (`lcm_grep`, `lcm_describe`, `lcm_expand`) so agents can search and recall details from compacted history

Nothing is lost. Raw messages stay in the database. Summaries link back to their source messages. Agents can drill into any summary to recover the original detail.

**It feels like talking to an agent that never forgets. Because it doesn't. In normal operation, you'll never need to think about compaction again.**

## Quick start

### Prerequisites

- OpenClaw with plugin context engine support
- Node.js 22+
- An LLM provider configured in OpenClaw (used for summarization)

### Install the plugin

Use OpenClaw's plugin installer (recommended):

```bash
openclaw plugins install @martian-engineering/lossless-claw
```

### Configuration

LCM is configured through a combination of plugin config and environment variables.

| Variable | Default | Description |
|----------|---------|-------------|
| `LCM_ENABLED` | `true` | Enable/disable the plugin |
| `LCM_DATABASE_PATH` | `~/.openclaw/lcm.db` | Path to the SQLite database |
| `LCM_CONTEXT_THRESHOLD` | `0.75` | Fraction of context window that triggers compaction |
| `LCM_FRESH_TAIL_COUNT` | `32` | Number of recent messages protected from compaction |
| `LCM_INCREMENTAL_MAX_DEPTH` | `0` | How deep incremental compaction goes |

### Recommended starting configuration

```
LCM_FRESH_TAIL_COUNT=32
LCM_INCREMENTAL_MAX_DEPTH=-1
LCM_CONTEXT_THRESHOLD=0.75
```

## License

MIT

</details>
