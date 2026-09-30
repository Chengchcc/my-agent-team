/** The backend's run protocol: the vocabulary the execution layer speaks
 *  (run-centric: one execute = one run = one outcome). Formerly
 *  packages/agent-contract; the child (oma) now declares its own contract
 *  and the ask shapes live in message (ADR 0040 decision 8). */
export type {
  AgentBackend,
  BackendRegistry,
  BackendRegistryEntry,
} from "./backend.js";
export type {
  BackendInputMessage,
  BackendRunInput,
  BackendRunOutcome,
  BackendRunSegment,
  PendingAction,
  PendingActionResponse,
  ResumeDecision,
} from "./run.js";
export type {
  ApprovalRequestedPayload,
  AskRequestedPayload,
  BackendEvent,
  CoreBackendEvent,
  BackendExtensionEvent,
} from "./event.js";
export type {
  AgentRunSnapshot,
  ProjectedHistoryItem,
  WorkspaceBinding,
} from "./history.js";
export type {
  BackendModel,
  BackendModelCatalog,
  BackendModelRef,
} from "./model.js";
export { normalizeReasoningEffort, REASONING_EFFORTS, type ReasoningEffort } from "./model.js";
export { BACKEND_KINDS, backendKindSchema, type BackendKind } from "./kinds.js";
export { guardedConsume } from "./guarded-consume.js";
export type { Usage, ToolPresentation } from "@chengchenccc/message";
export { debugLog } from "../../../infra/debug-log.js";
export {
  CONSENTED_MCP_TOOLS_ENV,
  encodeEnvList,
  MCP_EXPANDABLE_VARS_ENV,
} from "@chengchenccc/message";

/** The ask shapes are shared with the surfaces and live in message. */
export type {
  AskQuestionAnswerItem,
  AskQuestionFilled,
  AskQuestionInput,
  AskQuestionItem,
  AskQuestionOption,
  AskQuestionResult,
  AskQuestionValidation,
} from "@chengchenccc/message";
