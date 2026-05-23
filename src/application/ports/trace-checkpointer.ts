import type { TraceEvent } from '../../domain/trace-event'
import type { TraceRun, TraceSummary } from '../../domain/trace/types'

/** Unified trace persistence port — replaces TraceWriter + TraceStore. */
export interface TraceCheckpointer {
  append(event: TraceEvent): Promise<void>
  flush(): Promise<void>
  getRun(runId: string): Promise<TraceRun | null>
  listRecentSummaries(opts: {
    limit: number
    sessionId?: string
    since?: number
  }): Promise<TraceSummary[]>
}

/** Read-only subset exposed to evolution/memory via trace ext capability. */
export type TraceReader = Pick<TraceCheckpointer, 'getRun' | 'listRecentSummaries'>
