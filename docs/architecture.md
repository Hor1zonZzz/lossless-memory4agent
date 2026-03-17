# Architecture

## Overview

lossless-memory4agent is a DAG-based long-term memory management SDK for AI agents. It persists every conversation message in SQLite, automatically summarizes old messages into a hierarchical DAG structure, and provides retrieval methods for agents to search and recall details.

## Core Concepts

### DAG-based Compaction

Messages are compacted into a Directed Acyclic Graph of summaries:

```
[Raw Messages] → [Leaf Summaries (d0)] → [Condensed d1] → [Condensed d2] → ...
```

- **Leaf summaries (depth 0)**: Summarize chunks of ~20k tokens of raw messages into ~1200 token summaries
- **Condensed summaries (depth 1+)**: Merge multiple same-depth summaries into progressively more abstract nodes
- Each level preserves the most important information while discarding details

### Context Assembly

When the agent needs context, the assembler combines:
1. **Summaries** (oldest context, compressed) — presented as XML-wrapped user messages
2. **Fresh tail** (most recent N raw messages) — always included, never evicted

This fits within a token budget, giving the agent both historical context and full recent detail.

### Three-Level Escalation

Every summarization attempt follows an escalation strategy:
1. **Normal**: Standard prompt, temperature=0.2
2. **Aggressive**: Tighter prompt, temperature=0.1, lower token targets
3. **Deterministic fallback**: Simple truncation (~512 tokens) — ensures compaction always makes progress

## Module Structure

```
src/
├── engine.ts           # MemoryEngine — main entry point
├── assembler.ts        # Context assembly (summaries + messages → model context)
├── compaction.ts       # CompactionEngine (leaf & condensation passes)
├── summarize.ts        # Prompt builders and types for LLM summarization
├── retrieval.ts        # RetrievalEngine (grep, describe, expand)
├── large-files.ts      # Large file interception & exploration summaries
├── integrity.ts        # DAG integrity checks & metrics
├── transcript-repair.ts # Tool-use/result pairing sanitization
├── types.ts            # Core types (MemoryMessage, MemoryDependencies)
├── db/
│   ├── config.ts       # Configuration resolution
│   ├── connection.ts   # SQLite connection pooling (WAL mode)
│   ├── features.ts     # Runtime feature detection (FTS5)
│   └── migration.ts    # Schema migrations
└── store/
    ├── conversation-store.ts  # Messages and parts persistence
    ├── summary-store.ts       # Summary DAG persistence
    ├── fts5-sanitize.ts       # FTS5 query validation
    ├── full-text-fallback.ts  # LIKE-based search fallback
    └── index.ts               # Store exports
```

## Database Schema

### Tables

| Table | Purpose |
|-------|---------|
| `conversations` | Session → conversation mapping |
| `messages` | Raw message storage (seq, role, content, tokenCount) |
| `message_parts` | Rich content blocks (text, tool calls, results, reasoning) |
| `summaries` | Summary DAG nodes (leaf and condensed) |
| `summary_messages` | Links summaries → source messages |
| `summary_parents` | Links condensed → child summaries |
| `context_items` | Ordered list of what the model sees per conversation |
| `large_files` | Stored large file metadata |

### Summary Record

```typescript
{
  summaryId: string;      // "sum_" + 16 hex chars
  conversationId: number;
  kind: "leaf" | "condensed";
  depth: number;          // 0 for leaf, 1+ for condensed
  content: string;
  tokenCount: number;
  earliestAt: Date | null;
  latestAt: Date | null;
  descendantCount: number;
  descendantTokenCount: number;
  sourceMessageTokenCount: number;
}
```

## Data Flow

### Ingest
```
message → toStoredMessage() → interceptLargeFiles() → createMessage() → createMessageParts() → appendContextMessage()
```

### Compact
```
evaluate(threshold) → compactLeaf(oldest messages → leaf summary) → condensation(same-depth summaries → higher summary)
```

### Assemble
```
getContextItems() → resolveItems(summaries → XML, messages → from parts) → budget selection → sanitizeToolUseResultPairing()
```

### Grep/Describe/Expand
```
grep: FTS5 or LIKE search across messages + summaries
describe: lookup by sum_xxx or file_xxx ID
expand: traverse DAG children + source messages
```
