// Contracted event map — maps event names to their payload types.
// Pure type, no runtime cost. Used by ContractBus for emit() type safety.

import type { ProviderSelectedV1, LlmDeltaV1 } from '../provider-events'
import type { MemorySummaryReadyV1, MemorySummarizedV1, MemoryExtractStartedV1, MemoryExtractCompletedV1, MemoryExtractFailedV1 } from '../memory-events'
import type { EvolutionProposalAcceptedV1, EvolutionProposalRejectedV1, SkillsReloadedV1, EvolutionReviewStartedV1, EvolutionReviewCompletedV1, EvolutionReviewFailedV1 } from '../evolution-events'
import type { SessionCreatedV1, TurnStartedV1, TurnCompletedV1, TurnFailedV1, SessionCompactedV1 } from '../session-events'
import type { ToolExecutedV1 } from '../tool-events'
import type { PermissionRequiredV1, PermissionResolvedV1, AskUserQuestionRequiredV1, AskUserQuestionResolvedV1 } from '../permission-events'
import type { IdentityChangedV1 } from '../identity-events'
import type {
  AttachChangedV1,
  SessionResumedV1,
  SessionClosedV1,
  SessionRenamedV1,
  UserQuestionAnsweredV1,
  SystemShutdownRequestedV1,
  InputCancelledV1,
  TurnCancelledV1,
} from '../system-events'
import type { McpServerConnectedV1, McpServerDisconnectedV1, McpServerFailedV1, McpReloadedV1, McpToolsChangedV1 } from './mcp-events'
import type { InlineBlockV1 } from '../widget-events'

export interface ContractedEventMap {
  'provider.selected': ProviderSelectedV1
  'llm.delta': LlmDeltaV1
  'memory.summary.ready': MemorySummaryReadyV1
  'memory.summarized': MemorySummarizedV1
  'evolution.proposal.accepted': EvolutionProposalAcceptedV1
  'evolution.proposal.rejected': EvolutionProposalRejectedV1
  'skills.reloaded': SkillsReloadedV1
  'session.created': SessionCreatedV1
  'turn.started': TurnStartedV1
  'turn.completed': TurnCompletedV1
  'turn.failed': TurnFailedV1
  'session.compacted': SessionCompactedV1
  'tool.executed': ToolExecutedV1
  'permission.required': PermissionRequiredV1
  'permission.resolved': PermissionResolvedV1
  'ask-user-question.required': AskUserQuestionRequiredV1
  'ask-user-question.resolved': AskUserQuestionResolvedV1
  'identity.changed': IdentityChangedV1
  'attach.changed': AttachChangedV1
  'session.resumed': SessionResumedV1
  'session.closed': SessionClosedV1
  'session.renamed': SessionRenamedV1
  'user.question.answered': UserQuestionAnsweredV1
  'system.shutdown.requested': SystemShutdownRequestedV1
  'input.cancelled': InputCancelledV1
  'turn.cancelled': TurnCancelledV1
  'evolution.review.started': EvolutionReviewStartedV1
  'evolution.review.completed': EvolutionReviewCompletedV1
  'evolution.review.failed': EvolutionReviewFailedV1
  'memory.extract.started': MemoryExtractStartedV1
  'memory.extract.completed': MemoryExtractCompletedV1
  'memory.extract.failed': MemoryExtractFailedV1
  'mcp.server.connected': McpServerConnectedV1
  'mcp.server.disconnected': McpServerDisconnectedV1
  'mcp.server.failed': McpServerFailedV1
  'mcp.reloaded': McpReloadedV1
  'mcp.tools.changed': McpToolsChangedV1
  'tui.inline-block': InlineBlockV1
}

export type ContractedEventName = keyof ContractedEventMap
