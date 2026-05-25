export interface SubAgentStartedV1 {
  parentTurnId: string
  parentSessionId: string
  type: string
  subSessionId: string
  callId: string
  ts: number
}

export interface SubAgentCompletedV1 {
  parentTurnId: string
  parentSessionId: string
  type: string
  subSessionId: string
  callId: string
  ok: boolean
  usage: { input: number; output: number }
  finalText?: string
  ts: number
}
