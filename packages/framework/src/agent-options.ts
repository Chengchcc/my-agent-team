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
import type { ContextStore } from "./context.js";
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

export interface AgentRunOptions {
  signal?: AbortSignal;
  maxSteps?: number;
  stream?: boolean;
  maxForceContinues?: number;
  spanId?: string;
  steering?: SteeringQueue;
  followUp?: FollowUpQueue;
  origin?: unknown;
  /** Per-run context store, flushed to HookContext.context by framework at run start. */
  context?: ContextStore;
}

export type AgentEventListener = (event: AgentEvent) => void;

export interface Agent {
  readonly thread: Thread;
  run(input: string, opts?: AgentRunOptions): AsyncIterable<AgentEvent>;
  continue(opts?: AgentRunOptions): AsyncIterable<AgentEvent>;
  resume(command: ResumeCommand, opts?: AgentRunOptions): AsyncIterable<AgentEvent>;
  fork(messages?: Message[], id?: string): Agent;
  subscribe(listener: AgentEventListener): () => void;
}

export interface AgentConfig {
  model: ChatModel;
  tools?: readonly Tool[];
  systemPrompt?: string;
  plugins?: readonly Plugin[];
  checkpointer?: Checkpointer;
  contextManager?: ContextManager;
  logger?: Logger;
  sessionId?: string;
  messages?: Message[];
  startSpan?: (spanId: string, sessionId: string, opts?: unknown) => Promise<RunSpan> | RunSpan;
  /** Inject a meta user message before the first real user message each turn.
   *  Used for runtime context (date, workspace, skill index) that changes per-turn
   *  but shouldn't be baked into the system prompt. Returns XML string or null. */
  metaContext?: (ctx: {
    sessionId: string;
    threadMessages: readonly Message[];
    context: ContextStore;
  }) => string | null;
}

export interface PluginRunner {
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

export interface AgentRuntime {
  thread: Thread;
  plugins: PluginRunner;
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
  /** Per-run context store, set at run start. Plugins write to it via beforeModel,
   *  metaContext callback reads from it to compose the meta user message. */
  context: ContextStore;
  metaContext?: (ctx: {
    sessionId: string;
    threadMessages: readonly Message[];
    context: ContextStore;
  }) => string | null;
}
