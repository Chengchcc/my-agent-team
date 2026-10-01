/** The backend's run protocol: the vocabulary the execution layer speaks
 *  (run-centric: one execute = one run = one outcome). Formerly
 *  packages/agent-contract; the child (oma) now declares its own contract
 *  and the ask shapes live in message (ADR 0040 decision 8). */

/** The ask shapes are shared with the surfaces and live in message. */
export type {
  AskQuestionAnswerItem,
  AskQuestionFilled,
  AskQuestionInput,
  AskQuestionItem,
  AskQuestionOption,
  AskQuestionResult,
  AskQuestionValidation,
  ToolPresentation,
  Usage,
} from "@chengchenccc/message";
export {
  CONSENTED_MCP_TOOLS_ENV,
  encodeEnvList,
  MCP_EXPANDABLE_VARS_ENV,
} from "@chengchenccc/message";
export type {
  AgentBackend,
  BackendRegistry,
  BackendRegistryEntry,
} from "./backend.js";
export { debugLog } from "./debug-log.js";
export type {
  ApprovalRequestedPayload,
  AskRequestedPayload,
  BackendEvent,
  BackendExtensionEvent,
  CoreBackendEvent,
} from "./event.js";
export { guardedConsume } from "./guarded-consume.js";
export type {
  AgentRunSnapshot,
  ProjectedHistoryItem,
  WorkspaceBinding,
} from "./history.js";
export { BACKEND_KINDS, type BackendKind, backendKindSchema } from "./kinds.js";
export type {
  BackendModel,
  BackendModelCatalog,
  BackendModelRef,
} from "./model.js";
export { normalizeReasoningEffort, REASONING_EFFORTS, type ReasoningEffort } from "./model.js";
export type {
  BackendInputMessage,
  BackendRunInput,
  BackendRunOutcome,
  BackendRunSegment,
  PendingAction,
  PendingActionResponse,
  ResumeDecision,
} from "./run.js";
