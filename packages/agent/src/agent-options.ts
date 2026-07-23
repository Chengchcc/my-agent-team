import type { AgentEvent, AgentEventListener } from "@my-agent-team/framework";

export type AgentState =
  | "idle"
  | "running"
  | "compacting"
  | "retrying"
  | "waiting"
  | "done"
  | "error";

export interface AgentConfig {
  model: unknown;
  tools?: unknown[];
  plugins?: unknown[];
  contextManager?: unknown;
  systemPrompt?: string;
  sessionId?: string;
  checkpointer?: unknown;
  session?: unknown;
  logger?: unknown;
  maxSteps?: number;
  retry?: { maxAttempts: number; backoffMs: number; maxBackoffMs?: number };
  compaction?: { autoCompact?: boolean; keepRecent?: number };
  startSpan?: (...args: unknown[]) => unknown;
}

export type { AgentEvent, AgentEventListener };
