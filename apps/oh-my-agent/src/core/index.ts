// Public surface of the oma runtime core.
//
// This file is `core/index.ts` on purpose: it is a BARREL, not the runtime.
// It used to be `core/agent-runtime.ts`, which read like "the runtime" even
// though every symbol it exports comes from a subdirectory (the loop lives in
// ./runtime/, the stores in ./store/). Import from here so callers keep
// one stable seam; read ./runtime/README.md for the loop's file map.
// Honest scope: in-app consumers mostly import submodules directly; this
// barrel serves the app's public `src/index.ts` re-exports and tests that
// want the loop's whole contract in one import.

// Persistence

// Runtime
export type { AgentLoopListener, OmaLoopEvent } from "./runtime/agent-event.js";
export type {
  ContextBudget,
  ContextSummarizer,
  OmaLoopResult,
  OmaSession,
  OmaSessionOptions,
  StreamRule,
} from "./runtime/agent-loop.js";
export { createOmaSession } from "./runtime/agent-loop.js";
export type { CompactionResult } from "./runtime/compaction.js";
// Compaction + retry
export { compactSession } from "./runtime/compaction.js";
export {
  estimateContextTokens,
  isSilentContextOverflow,
  type TurnUsage,
  type UsageAnchor,
  usageTotalTokens,
} from "./runtime/context-estimate.js";
export type { CodingLoopInput, LoopInputDeps, LoopInputResult } from "./runtime/loop-input.js";
export { buildLoopInput } from "./runtime/loop-input.js";
// Plugin
export type { MetaSectionProvider, Plugin, PluginHooks, PluginTool } from "./runtime/plugin.js";
export { collectTools, renderMeta, validatePlugins } from "./runtime/plugin.js";
export type { PluginRuntime } from "./runtime/plugin-runtime.js";
// Prompt
export type { LoopMetaInput } from "./runtime/prompt.js";
export { renderLoopMeta } from "./runtime/prompt.js";
export type { RetryOptions } from "./runtime/retry.js";
export { retryStream } from "./runtime/retry.js";
export { createInMemorySessionStore } from "./store/in-memory-session-store.js";
export type {
  AppendBatchInput,
  AppendBatchResult,
  SessionStore,
} from "./store/session-store.js";
export type {
  CodingSessionEntry,
  CodingSessionMetadata,
  CodingSessionOperation,
  CodingSessionSnapshot,
  CompactionEntry,
  MessageEntry,
} from "./store/session-tree.js";
// Todo
export type { TodoItem, TodoStatus, TodoStore } from "./tools/todo-store.js";
