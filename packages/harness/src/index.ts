// New (Phase 1) — AgentSession + compaction + identityPlugin

export type {
  AgentSessionConfig,
  AgentSessionEvent,
  AgentState,
  CompactionSettings,
  ContextUsage,
  RetrySettings,
  SessionEventListener,
  ThinkingLevel,
  ToolInfo,
} from "./agent-session.js";
export { AgentSession } from "./agent-session.js";
// Existing (kept for backward compat, deleted in Phase 3)
export { bootstrap } from "./bootstrap.js";
export type {
  CompactionOptions,
  CompactionResult,
} from "./compaction.js";
export { compactThread, reflectionGuidance } from "./compaction.js";
export { createGenericAgent, type GenericAgentOptions } from "./create-generic-agent.js";
export type { IdentityPluginOptions } from "./plugins/identity-plugin.js";
export {
  BOOTSTRAP_TEMPLATE,
  identityPlugin,
} from "./plugins/identity-plugin.js";
export { verificationGuidance } from "./verify.js";
