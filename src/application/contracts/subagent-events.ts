export type SubAgentErrorType =
  | 'cancelled' | 'failed' | 'busy' | 'unknown_type'
  | 'max_rounds' | 'budget' | 'tool_failed' | 'tool_unavailable'
  | 'llm_failed' | 'response_truncated' | 'response_filtered'
  | 'provider_inconsistent' | 'empty_response'

export interface SubAgentStartedV1 {
  parentTurnId: string
  parentSessionId: string
  subSessionId: string
  type: string
  description: string
  callId: string
  ts: number
}

export interface SubAgentCompletedV1 {
  parentTurnId: string
  parentSessionId: string
  subSessionId: string
  type: string
  callId: string
  ok: boolean
  usage: { input: number; output: number }
  finalText?: string
  errorMessage?: string
  errorType?: SubAgentErrorType
  finishReason?: string
  durationMs: number
  ts: number
}

export interface SubAgentProgressV1 {
  parentTurnId: string
  parentSessionId: string
  subSessionId: string
  callId: string
  innerCallId: string
  toolName: string
  phase: 'start' | 'end'
  ok?: boolean
  durationMs?: number
  ts: number
}
