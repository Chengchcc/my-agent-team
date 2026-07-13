// AgentSession + compaction + session manager

export type {
  AgentState,
  CompactionSettings,
  ContextUsage,
  RetrySettings,
  SessionConfig,
  SessionEventListener,
} from "./agent-session.js";
export { AgentSession } from "./agent-session.js";
export { compactThread } from "./compaction.js";
// Factory interfaces for CLI/future use
export type { ModelFactory, PluginFactory, ToolFactory } from "./factories.js";
export type { SessionManager, SessionManagerConfig, StartSpanFn } from "./session-manager.js";
export { SqliteSessionManager } from "./session-manager.js";

// Built-in tools
export { createSubtaskTool, type SubtaskToolConfig } from "./tools/subtask.js";
