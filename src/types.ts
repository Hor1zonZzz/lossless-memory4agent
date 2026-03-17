/**
 * Core type definitions for the lossless-memory4agent SDK.
 */

import type { LcmConfig } from "./db/config.js";
import type { LcmSummarizeFn } from "./summarize.js";

/**
 * A message to be stored and managed by the memory engine.
 * Framework-agnostic: works with any agent framework's message format.
 */
export type MemoryMessage = {
  role: "user" | "assistant" | "system" | "tool" | "toolResult";
  content: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

/**
 * Minimal dependencies for the memory engine.
 * Only a summarize callback is required from the host.
 */
export interface MemoryDependencies {
  /** Memory engine configuration */
  config: LcmConfig;

  /**
   * Summarize function — the only external dependency.
   * The host provides this to control which LLM and parameters are used.
   */
  summarize: LcmSummarizeFn;

  /** Optional logger (defaults to console) */
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
}
