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

export interface ResumeCommand {
  approved: boolean;
  message?: string;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
  maxSteps?: number;
  stream?: boolean;
  maxForceContinues?: number;
  /** M17.2: The run's identity, assigned by the runner/backend. Injected so
   *  framework can emit MessageRevision with the correct messageId. Falls
   *  back to thread.id when not provided (standalone mode). */
  runId?: string;
}

export interface Agent {
  readonly thread: Thread;
  run(input: string, opts?: AgentRunOptions): AsyncIterable<AgentEvent>;
  /** Continue from existing checkpoint messages without appending a new user
   *  message. Use when the conversation context has already been written to the
   *  checkpointer (e.g. conversation-triggered runs where broadcastMessage()
   *  pre-projected the user's message). Fails if no user message exists. */
  continue(opts?: AgentRunOptions): AsyncIterable<AgentEvent>;
  resume(command: ResumeCommand, opts?: AgentRunOptions): AsyncIterable<AgentEvent>;
  fork(messages?: Message[], id?: string): Agent;
}

export interface AgentConfig {
  model: ChatModel;
  tools?: readonly Tool[];
  systemPrompt?: string;
  plugins?: readonly Plugin[];
  checkpointer?: Checkpointer;
  contextManager?: ContextManager;
  logger?: Logger;
  threadId?: string;
  /** Preloaded messages to bootstrap the thread. When provided, bypasses
   *  checkpointer.load() for the initial message state. The checkpointer
   *  is still used for subsequent saves during the run. */
  messages?: Message[];
}

// ─── Plugin runner ──────────────────────────────────────────────

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

// ─── Agent runtime (bundles shared state for extracted functions) ──

export interface AgentRuntime {
  thread: Thread;
  plugins: PluginRunner;
  toolMap: Map<string, Tool>;
  checkpointer: Checkpointer;
  contextManager: ContextManager;
  logger: Logger;
  model: ChatModel;
  tools: readonly Tool[];
  pendingEvents: AgentEvent[];
  save: (msgs: Message[]) => Promise<void>;
  /** M17.2: The run's identity — set at run/continue/resume start. */
  runId: string;
  /** M17.2: Accumulated tool states for the current assistant message.
   *  Updated in-place by executeOne; read when emitting message revisions. */
  toolStates: MessageToolState[];
  /** M17.2 fix: Run-level accumulated assistant blocks — all emit revisions use
   *  the full accumulated set so consumer mergeMessageRevision shows complete history.
   *  Per-step blocks are still pushed to thread.messages for LLM context. */
  assistantBlocks: ContentBlock[];
}
