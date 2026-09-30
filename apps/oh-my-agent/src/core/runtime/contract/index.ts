/** oma's own runtime contract: the loop, its input/output and event
 *  vocabulary, declared here rather than imported from the Product Backend
 *  (ADR 0040 decision 8 - the child defines its contract; the parent adapts).
 *
 *  Structural copy of the shapes the Product Backend's projection mirrors;
 *  the two are no longer wired by a shared package. */

// The ask shapes are shared with the Product surfaces and live in message
// (re-exported so oma files have a single contract barrel to import from).
export type {
  AskQuestionAnswerItem,
  AskQuestionFilled,
  AskQuestionInput,
  AskQuestionItem,
  AskQuestionOption,
  AskQuestionResult,
  AskQuestionValidation,
} from "@chengchenccc/message";
export {
  CONSENTED_MCP_TOOLS_ENV,
  childEnv,
  decodeEnvList,
  encodeEnvList,
  MCP_EXPANDABLE_VARS_ENV,
} from "./env.js";
export type {
  BackendEvent,
  ToolPresentation,
  Usage,
} from "./event.js";
export type {
  AgentRunSnapshot,
  ProjectedHistoryItem,
  WorkspaceBinding,
} from "./history.js";
export type { BackendModel, BackendModelCatalog, BackendModelRef } from "./model.js";
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
