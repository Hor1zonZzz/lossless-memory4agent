# Full-Text Search (FTS5)

## Overview

lossless-memory4agent uses SQLite FTS5 for fast full-text search across messages and summaries. When FTS5 is unavailable, it falls back to LIKE-based search automatically.

## FTS5 Availability

FTS5 is detected at runtime via `getLcmDbFeatures()`. It's available in most Node.js builds with the built-in `node:sqlite` module.

When FTS5 is unavailable:
- `grep()` with `mode: "full_text"` falls back to LIKE-based search
- Search still works, just slower on large datasets
- A warning is logged at startup

## Search Modes

### Regex mode (`mode: "regex"`)
Uses SQLite GLOB patterns. Good for exact pattern matching.

```typescript
await engine.grep({
  query: "database.*migration",
  mode: "regex",
  scope: "both",
});
```

### Full-text mode (`mode: "full_text"`)
Uses FTS5 (or LIKE fallback). Good for natural language queries.

```typescript
await engine.grep({
  query: "authentication token refresh",
  mode: "full_text",
  scope: "summaries",
});
```

## Building Node.js with FTS5

If your Node.js build doesn't include FTS5, you can:

1. Use a Node.js version >= 22.x (includes `node:sqlite` with FTS5)
2. Build Node.js from source with `--enable-fts5`
3. Use the LIKE fallback (no action needed — it's automatic)
