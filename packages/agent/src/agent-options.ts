import type {
  ChatModel,
  Checkpointer,
  ContextManager,
  Logger,
  Plugin,
  RunSpan,
  Session,
  Tool,
} from "./framework-adapter.js";
import type { AgentEvent, AgentEventListener } from "./framework-adapter.js";

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
  startSpan?: (spanId: string, sessionId: string, opts?: unknown) => RunSpan | Promise<RunSpan>;
  maxSteps?: number;
  retry?: { maxAttempts: number; backoffMs: number; maxBackoffMs?: number };
  compaction?: { autoCompact?: boolean; keepRecent?: number };
}

export type { AgentEvent, AgentEventListener };
