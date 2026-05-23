import type { HistoryRecordV1 } from '../contracts'

export interface SessionHistoryPort {
  get(sessionId: string): HistoryRecordV1[]
  appendBatch(sessionId: string, msgs: HistoryRecordV1[]): Promise<void>
  replace(sessionId: string, msgs: HistoryRecordV1[]): Promise<void>
}
