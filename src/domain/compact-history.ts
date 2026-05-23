import type { HistoryRecordV1 } from '../application/contracts'

export interface CompactInput {
  history: HistoryRecordV1[]
  summary: string
  keepRecent: number
  sessionId: string
  now?: number
}

export interface CompactOutput {
  newHistory: HistoryRecordV1[]
  removedCount: number
  summaryRecord: HistoryRecordV1 | null
}

export function compactHistory(input: CompactInput): CompactOutput {
  const { history, summary, keepRecent, sessionId } = input
  const now = input.now ?? Date.now()
  if (history.length <= keepRecent) {
    return { newHistory: history, removedCount: 0, summaryRecord: null }
  }
  const cutoff = history.length - keepRecent
  const olderSlice = history.slice(0, cutoff)
  const recent = history.slice(cutoff)
  const summaryRecord: HistoryRecordV1 = {
    kind: 'history.record', version: 1, sessionId,
    role: 'system',
    content: `[Prior conversation summary (${olderSlice.length} msgs compacted)]\n${summary}`,
    ts: now,
    metadata: {
      synthetic: 'compact',
      removedCount: olderSlice.length,
      sourceRange: [olderSlice[0]!.ts, olderSlice[olderSlice.length - 1]!.ts],
    },
  }
  return {
    newHistory: [summaryRecord, ...recent],
    removedCount: olderSlice.length,
    summaryRecord,
  }
}
