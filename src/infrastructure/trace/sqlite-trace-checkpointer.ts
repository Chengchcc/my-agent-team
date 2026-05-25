import type { Database } from 'bun:sqlite'
import type { TraceCheckpointer } from '../../application/ports/trace-checkpointer'
import type { TraceEvent } from '../../domain/trace-event'
import type { TraceRun, TraceSummary } from '../../domain/trace/types'

export class SqliteTraceCheckpointer implements TraceCheckpointer {
  private seq = 0

  constructor(private db: Database, private runId: string) {
    db.run(`INSERT INTO trace_runs (run_id, session_id, started_at, outcome) VALUES (?, ?, ?, 'running')`, [runId, '', Date.now()])
  }

  async append(event: TraceEvent): Promise<void> {
    this.seq++
    this.db.run(
      `INSERT INTO trace_events (run_id, seq, turn_id, kind, ts, payload_json) VALUES (?, ?, ?, ?, ?, ?)`,
      [this.runId, this.seq, event.turnId, event.type, event.timestamp.getTime(), JSON.stringify(event.payload)],
    )
    if (event.type === 'turn.started') {
      this.db.run('UPDATE trace_runs SET total_turns = total_turns + 1 WHERE run_id = ?', [this.runId])
    }
  }

  async flush(): Promise<void> { /* WAL already written */ }

  async getRun(runId: string): Promise<TraceRun | null> {
    const row = this.db.query(
      `SELECT run_id, session_id, started_at, ended_at, outcome, total_turns, total_tool_calls,
              total_errors, tokens_in, tokens_out, summary_json FROM trace_runs WHERE run_id = ?`,
    ).get(runId) as Record<string, unknown> | null
    if (!row) return null
    const summary: TraceSummary = row.summary_json ? JSON.parse(row.summary_json as string) as TraceSummary : {
      totalTurns: (row.total_turns ?? 0) as number, totalToolCalls: (row.total_tool_calls ?? 0) as number,
      totalErrors: (row.total_errors ?? 0) as number,
      totalTokens: { input: (row.tokens_in ?? 0) as number, output: (row.tokens_out ?? 0) as number },
      outcome: (row.outcome as TraceSummary['outcome']) ?? 'completed',
    }
    return { id: row.run_id as string, sessionId: row.session_id as string, startTime: row.started_at as number, endTime: row.ended_at as number, model: '', turns: [], summary }
  }

  async listRecentSummaries(opts: { limit: number; sessionId?: string; since?: number }): Promise<TraceSummary[]> {
    let sql = `SELECT summary_json, total_turns, total_tool_calls, total_errors, tokens_in, tokens_out, outcome FROM trace_runs WHERE 1=1`
    const params: Array<string | number> = []
    if (opts.sessionId) { sql += ' AND session_id = ?'; params.push(opts.sessionId) }
    if (opts.since) { sql += ' AND started_at >= ?'; params.push(String(opts.since)) }
    sql += ' ORDER BY started_at DESC LIMIT ?'; params.push(String(opts.limit))
    const rows = this.db.query(sql).all(...params.map(p => typeof p === 'string' ? p : p)) as Array<Record<string, unknown>>
    return rows.map(row => row.summary_json ? JSON.parse(row.summary_json as string) as TraceSummary : {
      totalTurns: (row.total_turns ?? 0) as number, totalToolCalls: (row.total_tool_calls ?? 0) as number,
      totalErrors: (row.total_errors ?? 0) as number,
      totalTokens: { input: (row.tokens_in ?? 0) as number, output: (row.tokens_out ?? 0) as number },
      outcome: (row.outcome as TraceSummary['outcome']) ?? 'completed',
    })
  }

  finalize(outcome: string, summary?: TraceSummary): void {
    this.db.run(`UPDATE trace_runs SET ended_at = ?, outcome = ?, summary_json = ? WHERE run_id = ?`, [Date.now(), outcome, summary ? JSON.stringify(summary) : null, this.runId])
  }
}
