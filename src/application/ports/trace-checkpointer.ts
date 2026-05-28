import type { TraceEvent } from '../../domain/trace-event'
import type { TraceRun, TraceSummary } from '../../domain/trace/types'

export interface TraceEventRow {
  seq: number
  turnId: string
  kind: string
  ts: number
  payload: Record<string, unknown>
}

export interface TraceRunListRow {
  id: string
  sessionId: string
  startedAt: number
  totalTurns: number
  outcome: string
}

/** Unified trace persistence port — replaces TraceWriter + TraceStore. */
export interface TraceCheckpointer {
  append(event: TraceEvent): Promise<void>
  flush(): Promise<void>
  getRun(runId: string): Promise<TraceRun | null>
  getEvents(runId: string, kinds?: string[]): Promise<TraceEventRow[]>
  listRecentSummaries(opts: {
    limit: number
    sessionId?: string
    since?: number
  }): Promise<TraceSummary[]>
  listRecentRuns(opts: {
    limit: number
    sessionId?: string
    since?: number
  }): Promise<TraceRunListRow[]>
}

/** Read-only subset exposed to evolution/memory via trace ext capability. */
export type TraceReader = Pick<TraceCheckpointer, 'getRun' | 'getEvents' | 'listRecentSummaries' | 'listRecentRuns'>
