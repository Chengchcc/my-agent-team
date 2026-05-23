import type { TraceCheckpointer } from '../../application/ports/trace-checkpointer'
import type { TraceEvent } from '../../domain/trace-event'
import type { TraceRun, TraceSummary } from '../../domain/trace/types'
import { join } from 'path'
import { mkdir, appendFile, readFile, readdir } from 'fs/promises'

/**
 * NdjsonCheckpointer — NDJSON file per run.
 * Layout: baseDir / sessionId / {runId}.jsonl
 * One line = one TraceEvent.
 */
export class NdjsonCheckpointer implements TraceCheckpointer {
  private readonly baseDir: string
  private readonly sessionId: string
  private readonly runId: string

  constructor(baseDir: string, sessionId: string) {
    this.baseDir = baseDir
    this.sessionId = sessionId
    this.runId = `run-${Date.now()}`
  }

  private get filePath(): string {
    return join(this.baseDir, this.sessionId, `${this.runId}.jsonl`)
  }

  async append(event: TraceEvent): Promise<void> {
    await mkdir(join(this.baseDir, this.sessionId), { recursive: true })
    const serialized = JSON.stringify(event) + '\n'
    await appendFile(this.filePath, serialized, 'utf-8')
  }

  async flush(): Promise<void> {
    // NDJSON appendFile writes synchronously; no-op
  }

  async getRun(runId: string): Promise<TraceRun | null> {
    try {
      const dirs = await readdir(this.baseDir, { withFileTypes: true })
      for (const d of dirs) {
        if (!d.isDirectory()) continue
        const fp = join(this.baseDir, d.name, `${runId}.jsonl`)
        try {
          const content = await readFile(fp, 'utf-8')
          const lines = content.trim().split('\n').filter(Boolean)
          if (lines.length === 0) continue
          const events = lines.map(line => {
            const obj = JSON.parse(line) as Record<string, unknown>
            return { ...obj, timestamp: new Date(obj.timestamp as string) } as TraceEvent
          })
          return {
            id: runId,
            sessionId: d.name,
            startTime: events[0]?.timestamp?.getTime() ?? 0,
            endTime: events[events.length - 1]?.timestamp?.getTime() ?? 0,
            model: 'unknown',
            turns: [],
            summary: {
              totalTurns: 0,
              totalToolCalls: 0,
              totalErrors: 0,
              totalTokens: {},
              outcome: 'completed',
            },
          }
        } catch { /* not in this dir, continue */ }
      }
      return null
    } catch {
      return null
    }
  }

  async listRecentSummaries(opts: {
    limit: number
    sessionId?: string
    since?: number
  }): Promise<TraceSummary[]> {
    const summaries: TraceSummary[] = []
    try {
      const targetDir = opts.sessionId
        ? join(this.baseDir, opts.sessionId)
        : this.baseDir
      const entries = await readdir(targetDir, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
        summaries.push({
          totalTurns: 0,
          totalToolCalls: 0,
          totalErrors: 0,
          totalTokens: {},
          outcome: 'completed',
        })
      }
    } catch { /* dir may not exist */ }
    return summaries.slice(0, opts.limit)
  }
}
