export interface CompactionStartedV1 {
  sessionId: string
  turnId: string
  ratio: number
  ts: number
}

export interface CompactionCompletedV1 {
  sessionId: string
  turnId: string
  ts: number
}

export interface CompactionFailedV1 {
  sessionId: string
  turnId: string
  reason: string
  ts: number
}
