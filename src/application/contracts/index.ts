// Event envelope
export type { EventEnvelope, CreateEventOpts } from './event-envelope';
export { createEvent } from './event-envelope';

// DataPlane
export type { DataPlaneEvent, DataPlaneEventType } from './dataplane-event';

// ControlPlane (JSON-RPC 2.0)
export type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  JsonRpcNotification,
  JsonRpcMessage,
  JsonRpcErrorCode,
} from './controlplane';
export {
  JSONRPC_ERRORS,
  isRequest,
  isNotification,
  buildSuccess,
  buildError,
} from './controlplane';

// Content
export type { ContentBlock } from './content-block';

// Provider events
export type { ProviderSelectedV1, LlmDeltaV1 } from './provider-events';

// Memory events
export type { MemorySummaryReadyV1, MemorySummarizedV1 } from './memory-events';

// Evolution events
export type {
  EvolutionProposalAcceptedV1,
  EvolutionProposalRejectedV1,
  SkillsReloadedV1,
  EvolutionReviewStartedV1,
  EvolutionReviewCompletedV1,
  EvolutionReviewFailedV1,
} from './evolution-events';

// Session events
export type { SessionCreatedV1, TurnStartedV1, TurnCompletedV1, TurnFailedV1 } from './session-events';

// Tool events
export type { ToolExecutedV1 } from './tool-events';

// Permission events
export type { PermissionRequiredV1, PermissionResolvedV1, AskUserQuestionRequiredV1, AskUserQuestionResolvedV1 } from './permission-events';

// Identity events
export type { IdentityChangedV1 } from './identity-events';

// History
export type { HistoryRecordV1 } from './history-record';
export { parseHistoryLine } from './history-record';

// Widget
export type { WidgetPayloadMap, WidgetName, WidgetPayloadFor } from './widget-payload-map'
export { emitInlineBlock } from './widget-events'
export type { InlineBlockV1 } from './widget-events'

// Shared
export type { DecodeResult } from './shared/codec';
