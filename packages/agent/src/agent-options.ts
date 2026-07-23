import type {
  AgentEvent,
  AgentEventListener,
  AgentHooks,
  ChatModel,
  Checkpointer,
  ContextManager,
  Logger,
  Plugin,
  RunSpan,
  Session,
  Tool,
} from "./framework-adapter.js";

export type AgentState =
  | "idle"
  | "running"
  | "compacting"
  | "retrying"
  | "waiting"
  | "done"
  | "error";

export interface AgentConfig {
  model: ChatModel;
  tools?: Tool[];
  plugins?: Plugin[];
  contextManager?: ContextManager;
  systemPrompt?: string;
  sessionId?: string;
  checkpointer?: Checkpointer;
  session?: Session;
  logger?: Logger;
  hooks?: AgentHooks;
  maxSteps?: number;
  retry?: { maxAttempts: number; backoffMs: number; maxBackoffMs?: number };
  compaction?: { autoCompact?: boolean; keepRecent?: number };
  startSpan?: (spanId: string, sessionId: string, opts?: unknown) => RunSpan | Promise<RunSpan>;
}

export type { AgentEvent, AgentEventListener };
