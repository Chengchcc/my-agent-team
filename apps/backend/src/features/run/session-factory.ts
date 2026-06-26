import type { ChatModel, Tool } from "@my-agent-team/core";
import type { AgentSession } from "@my-agent-team/harness";
import type { Checkpointer, ContextManager, Plugin } from "@my-agent-team/framework";

/**
 * Narrow interface: consumers declare "give me a runnable session" without
 * knowing how it's materialized. Replaces the inline `new AnthropicChatModel` /
 * `sqliteCheckpointer` / `new AgentSession` pattern in executeAgentRun.
 */
export interface SessionFactory {
  /** Get an existing persistent session by sessionId, or create one from spec. */
  getOrCreate(sessionId: string, spec: SessionSpec): AgentSession;
  /** Explicitly dispose a session (conversation archive / agent offline / issue close). */
  dispose(sessionId: string): void;
}

/** The ingredients needed to materialize a fresh AgentSession. */
export interface SessionSpec {
  agentId: string;
  cwd: string;
  model: ChatModel; // already constructed, not new'd inside factory
  plugins: Plugin[];
  tools: Tool[];
  checkpointer: Checkpointer; // already constructed
  contextManager: ContextManager;
}
