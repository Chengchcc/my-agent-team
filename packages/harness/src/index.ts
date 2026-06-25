// AgentSession + compaction + identityPlugin
export { AgentSession } from "./agent-session.js";
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
export { compactThread, reflectionGuidance } from "./compaction.js";
export type { CompactionOptions, CompactionResult } from "./compaction.js";
export {
  BOOTSTRAP_TEMPLATE,
  identityPlugin,
} from "./plugins/identity-plugin.js";
export type { IdentityPluginOptions } from "./plugins/identity-plugin.js";
export { verificationGuidance } from "./verify.js";
