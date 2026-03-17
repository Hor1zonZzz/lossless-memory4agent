# Configuration

## Config Resolution

Configuration is resolved with three-tier precedence:
1. **Environment variables** (highest priority)
2. **Plugin config object** (passed to `resolveLcmConfig()`)
3. **Hardcoded defaults** (lowest priority)

## Usage

```typescript
import { resolveLcmConfig } from "lossless-memory4agent";

// Use defaults
const config = resolveLcmConfig();

// Override via config object
const config = resolveLcmConfig(process.env, {
  contextThreshold: 0.8,
  freshTailCount: 16,
  databasePath: "./my-memory.db",
});
```

## Config Options

| Option | Env Var | Default | Description |
|--------|---------|---------|-------------|
| `enabled` | `LCM_ENABLED` | `true` | Enable/disable the memory engine |
| `databasePath` | `LCM_DATABASE_PATH` | `~/.lossless-memory/lcm.db` | SQLite database path |
| `contextThreshold` | `LCM_CONTEXT_THRESHOLD` | `0.75` | Fraction of budget that triggers compaction |
| `freshTailCount` | `LCM_FRESH_TAIL_COUNT` | `32` | Number of recent messages always kept raw |
| `leafMinFanout` | `LCM_LEAF_MIN_FANOUT` | `8` | Min raw messages per leaf summary |
| `condensedMinFanout` | `LCM_CONDENSED_MIN_FANOUT` | `4` | Min summaries per condensed node |
| `condensedMinFanoutHard` | `LCM_CONDENSED_MIN_FANOUT_HARD` | `2` | Relaxed fanout for forced sweeps |
| `incrementalMaxDepth` | `LCM_INCREMENTAL_MAX_DEPTH` | `0` | Depth limit for incremental compaction |
| `leafChunkTokens` | `LCM_LEAF_CHUNK_TOKENS` | `20000` | Max source tokens per leaf chunk |
| `leafTargetTokens` | `LCM_LEAF_TARGET_TOKENS` | `1200` | Target leaf summary size |
| `condensedTargetTokens` | `LCM_CONDENSED_TARGET_TOKENS` | `2000` | Target condensed summary size |
| `maxExpandTokens` | `LCM_MAX_EXPAND_TOKENS` | `4000` | Token cap for expand operations |
| `largeFileTokenThreshold` | `LCM_LARGE_FILE_TOKEN_THRESHOLD` | `25000` | Threshold for large file interception |
| `autocompactDisabled` | `LCM_AUTOCOMPACT_DISABLED` | `false` | Disable automatic compaction |
| `timezone` | `TZ` | System default | IANA timezone for timestamps |

## Tuning Guidelines

### For short conversations (< 50 turns)
Default settings work well. Compaction won't trigger until context exceeds 75% of the token budget.

### For very long conversations (hundreds of turns)
- Increase `freshTailCount` if you need more recent context
- Decrease `contextThreshold` (e.g., 0.6) to trigger compaction earlier
- Increase `leafChunkTokens` if summaries are too granular

### For cost optimization
- Decrease `leafTargetTokens` and `condensedTargetTokens` for more aggressive compression
- Use a cheaper model in your `summarize` callback for compaction
