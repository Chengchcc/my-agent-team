export interface SessionPlanProposedV1 {
  sessionId: string
  planMd: string
  callId: string
  ts: number
}

export interface SessionPlanResolvedV1 {
  sessionId: string
  decision: 'approve' | 'reject' | 'keep'
  ts: number
}

export interface SessionModeChangedV1 {
  sessionId: string
  from: string
  to: string
  ts: number
}
