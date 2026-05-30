import type { SubAgentErrorType } from '../../application/contracts/subagent-events'

export interface SubAgentInnerToolCall {
  readonly innerCallId: string
  readonly name: string
  readonly status: 'running' | 'ok' | 'error'
  readonly durationMs?: number
}

export interface SubAgentTaskPayload {
  readonly callId: string
  readonly subagentType: string
  readonly description: string
  readonly status: 'running' | 'ok' | 'warn' | 'failed' | 'cancelled'
  readonly subSessionId: string
  readonly innerToolCalls: ReadonlyArray<SubAgentInnerToolCall>
  readonly finalText?: string
  readonly usage?: { input: number; output: number }
  readonly errorMessage?: string
  readonly errorType?: SubAgentErrorType
  readonly durationMs?: number
}

declare module '../../application/contracts/widget-payload-map' {
  interface WidgetPayloadMap {
    'subagent.task': SubAgentTaskPayload
  }
}
