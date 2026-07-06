import type {
  ChatModel,
  ContentBlock,
  Tool,
  ToolResultBlock,
  ToolUseBlock,
} from "@my-agent-team/core";
import type { Message, MessageToolState } from "@my-agent-team/message";
import type { AgentEvent } from "./agent-event.js";
import type { Checkpointer } from "./checkpointer.js";
import type { ContextManager } from "./context-manager.js";
import type { Logger } from "./logger.js";
import type { Plugin, StopDecision } from "./plugin.js";
import type { Thread } from "./thread.js";
import type { RunSpan } from "./trace.js";

export interface ResumeCommand {
  approved: boolean;
  message?: string;
}

export interface SteeringQueue {
  drain(): Message[];
}

export interface FollowUpQueue {
  drain(): Message[];
}

export interface AgentRunOptions<Ctx = Record<string, unknown>> {
  signal?: AbortSignal;
  maxSteps?: number;
  stream?: boolean;
  maxForceContinues?: number;
  spanId?: string;
  steering?: SteeringQueue;
  followUp?: FollowUpQueue;
  origin?: unknown;
  /** Per-run data, flushed to HookContext.data by framework at run start. */
  data?: Ctx;
}

export type AgentEventListener = (event: AgentEvent) => void;

export interface Agent<Ctx = Record<string, unknown>> {
  readonly thread: Thread;
  run(input: string, opts?: AgentRunOptions<Ctx>): AsyncIterable<AgentEvent>;
  continue(opts?: AgentRunOptions<Ctx>): AsyncIterable<AgentEvent>;
  resume(command: ResumeCommand, opts?: AgentRunOptions<Ctx>): AsyncIterable<AgentEvent>;
  fork(messages?: Message[], id?: string): Agent<Ctx>;
  subscribe(listener: AgentEventListener): () => void;
}

export interface AgentConfig<Ctx = Record<string, unknown>> {
  model: ChatModel;
  tools?: readonly Tool[];
  systemPrompt?: string;
  plugins?: readonly Plugin<Ctx>[];
  checkpointer?: Checkpointer;
  contextManager?: ContextManager;
  logger?: Logger;
  sessionId?: string;
  messages?: Message[];
  startSpan?: (spanId: string, sessionId: string, opts?: unknown) => Promise<RunSpan> | RunSpan;
}

export interface PluginRunner<Ctx = Record<string, unknown>> {
  /** Phantom key to carry Ctx for type inference. Not used at runtime. */
  readonly _ctx?: Ctx;
  fireBeforeModel(msgs: Message[]): Promise<Message[]>;
  fireAfterModel(msgs: readonly Message[]): Promise<void>;
  fireBeforeTool(
    call: ToolUseBlock,
    msgs: readonly Message[],
  ): Promise<{ skip?: boolean; input?: unknown; result?: string; isError?: boolean } | undefined>;
  fireAfterTool(
    call: ToolUseBlock,
    result: ToolResultBlock,
    msgs: readonly Message[],
  ): Promise<void>;
  fireBeforeRun(msgs: readonly Message[]): Promise<readonly Message[]>;
  fireBeforeStop(msgs: readonly Message[]): Promise<StopDecision | undefined>;
}

export interface AgentRuntime<Ctx = Record<string, unknown>> {
  thread: Thread;
  plugins: PluginRunner<Ctx>;
  toolMap: ReadonlyMap<string, Tool>;
  checkpointer: Checkpointer;
  contextManager: ContextManager;
  logger: Logger;
  model: ChatModel;
  tools: readonly Tool[];
  pendingEvents: AgentEvent[];
  save: (msgs: Message[]) => Promise<void>;
  spanId: string;
  toolStates: MessageToolState[];
  assistantBlocks: ContentBlock[];
  subscribers: Set<AgentEventListener>;
}
