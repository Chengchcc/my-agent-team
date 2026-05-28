import type { Database } from 'bun:sqlite'
import type { TraceCheckpointer, TraceRunListRow } from '../../application/ports/trace-checkpointer'
import type { TraceEvent } from '../../domain/trace-event'
import type { TraceRun, TraceSummary, TraceTurn } from '../../domain/trace/types'

export class SqliteTraceCheckpointer implements TraceCheckpointer {
  private seq = 0

  constructor(private db: Database, private runId: string, private sessionId: string) {
    db.run(`INSERT OR IGNORE INTO trace_runs (run_id, session_id, started_at, outcome) VALUES (?, ?, ?, 'running')`, [runId, sessionId, Date.now()])
  }

  updateSessionId(sid: string): void {
    if (sid && sid !== this.sessionId) {
      this.sessionId = sid
      this.db.run('UPDATE trace_runs SET session_id = ? WHERE run_id = ?', [sid, this.runId])
    }
  }

  async append(event: TraceEvent): Promise<void> {
    this.seq++
    this.db.run(
      `INSERT INTO trace_events (run_id, seq, turn_id, kind, ts, payload_json) VALUES (?, ?, ?, ?, ?, ?)`,
      [this.runId, this.seq, event.turnId, event.type, event.timestamp.getTime(), JSON.stringify(event.payload)],
    )
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- only aggregate-column relevant events
    switch (event.type) {
      case 'turn.started':
        this.db.run('UPDATE trace_runs SET total_turns = total_turns + 1 WHERE run_id = ?', [this.runId])
        if (event.sessionId) this.updateSessionId(event.sessionId)
        break
      case 'tool.call':
        this.db.run('UPDATE trace_runs SET total_tool_calls = total_tool_calls + 1 WHERE run_id = ?', [this.runId])
        break
      case 'turn.failed':
        this.db.run('UPDATE trace_runs SET total_errors = total_errors + 1 WHERE run_id = ?', [this.runId])
        break
      case 'llm.end':
        if (event.payload?.usage) {
          const u = event.payload.usage as { input?: number; output?: number }
          this.db.run('UPDATE trace_runs SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ? WHERE run_id = ?',
            [u.input ?? 0, u.output ?? 0, this.runId])
        }
        break
      default:
        break
    }
  }

  async flush(): Promise<void> { /* WAL already written */ }

  async getEvents(
    runId: string,
    kinds?: string[],
  ): Promise<Array<{ seq: number; turnId: string; kind: string; ts: number; payload: Record<string, unknown> }>> {
    let sql = `SELECT seq, turn_id, kind, ts, payload_json FROM trace_events WHERE run_id = ?`
    const params: Array<string | number> = [runId]
    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`
      params.push(...kinds)
    }
    sql += ' ORDER BY seq ASC'
    const rows = this.db.query(sql).all(...params) as Array<Record<string, unknown>>
    return rows.map(r => ({
      seq: Number(r.seq),
      turnId: (r.turn_id as string) ?? '',
      kind: r.kind as string,
      ts: Number(r.ts),
      payload: JSON.parse(r.payload_json as string) as Record<string, unknown>,
    }))
  }

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
    const turns = this.rebuildTurns(runId)
    return { id: row.run_id as string, sessionId: row.session_id as string, startTime: row.started_at as number, endTime: row.ended_at as number, model: '', turns, summary }
  }

  private rebuildTurns(runId: string): TraceTurn[] {
    const rows = this.db.query(
      `SELECT turn_id, kind, ts, payload_json FROM trace_events
       WHERE run_id = ? AND kind IN ('message.user', 'message.assistant', 'tool.call', 'tool.result')
       ORDER BY seq ASC`
    ).all(runId) as Array<Record<string, unknown>>

    const byTurn = new Map<string, Array<{ kind: string; ts: number; payload: Record<string, unknown> }>>()
    const turnOrder: string[] = []

    for (const row of rows) {
      const turnId = row.turn_id as string
      if (!turnId) continue
      if (!byTurn.has(turnId)) {
        byTurn.set(turnId, [])
        turnOrder.push(turnId)
      }
      byTurn.get(turnId)!.push({
        kind: row.kind as string,
        ts: Number(row.ts),
        payload: JSON.parse(row.payload_json as string) as Record<string, unknown>,
      })
    }

    return turnOrder.map((turnId, idx) => {
      const evs = byTurn.get(turnId)!

      const userEvt = evs.find(e => e.kind === 'message.user')
      const userMessage = userEvt?.payload?.content as string | undefined

      const assistantEvts = evs.filter(e => e.kind === 'message.assistant')
      const lastAssistant = assistantEvts[assistantEvts.length - 1]

      const modelResponse = lastAssistant ? {
        text: (lastAssistant.payload.content as string) ?? '',
        thinking: undefined,
        toolCalls: ((lastAssistant.payload.toolCalls as Array<{ name: string }>) ?? []).map(tc => ({
          name: tc.name,
          arguments: {} as Record<string, unknown>,
        })),
        usage: (lastAssistant.payload.usage as Record<string, number>) ?? {},
      } : undefined

      const toolCallEvts = evs.filter(e => e.kind === 'tool.call')
      const toolResultEvts = evs.filter(e => e.kind === 'tool.result')
      const toolExecutions = toolCallEvts.map((tc, i) => {
        const result = toolResultEvts[i]
        return {
          toolName: (tc.payload.name as string) ?? (tc.payload.toolName as string) ?? 'unknown',
          success: result ? !(result.payload.isError || result.payload.error) : true,
          durationMs: result ? Number(result.payload.durationMs ?? 0) : 0,
          error: result?.payload.error as string | undefined,
        }
      })

      return { turnIndex: idx, userMessage, modelResponse, toolExecutions }
    })
  }

  async listRecentSummaries(opts: { limit: number; sessionId?: string; since?: number }): Promise<TraceSummary[]> {
    let sql = `SELECT summary_json, total_turns, total_tool_calls, total_errors, tokens_in, tokens_out, outcome FROM trace_runs WHERE 1=1`
    const params: Array<string | number> = []
    if (opts.sessionId) { sql += ' AND session_id = ?'; params.push(opts.sessionId) }
    if (opts.since) { sql += ' AND started_at >= ?'; params.push(opts.since) }
    sql += ' ORDER BY started_at DESC LIMIT ?'; params.push(opts.limit)
    const rows = this.db.query(sql).all(...params) as Array<Record<string, unknown>>
    return rows.map(row => row.summary_json ? JSON.parse(row.summary_json as string) as TraceSummary : {
      totalTurns: (row.total_turns ?? 0) as number, totalToolCalls: (row.total_tool_calls ?? 0) as number,
      totalErrors: (row.total_errors ?? 0) as number,
      totalTokens: { input: (row.tokens_in ?? 0) as number, output: (row.tokens_out ?? 0) as number },
      outcome: (row.outcome as TraceSummary['outcome']) ?? 'completed',
    })
  }

  async listRecentRuns(opts: { limit: number; sessionId?: string; since?: number }): Promise<TraceRunListRow[]> {
    let sql = `SELECT run_id, session_id, started_at, total_turns, outcome FROM trace_runs WHERE 1=1`
    const params: Array<string | number> = []
    if (opts.sessionId) { sql += ' AND session_id = ?'; params.push(opts.sessionId) }
    if (opts.since) { sql += ' AND started_at >= ?'; params.push(opts.since) }
    sql += ' ORDER BY started_at DESC LIMIT ?'; params.push(opts.limit)
    const rows = this.db.query(sql).all(...params) as Array<Record<string, unknown>>
    return rows.map(r => ({
      id: r.run_id as string,
      sessionId: (r.session_id as string) ?? '',
      startedAt: Number(r.started_at ?? 0),
      totalTurns: Number(r.total_turns ?? 0),
      outcome: (r.outcome as string) ?? 'unknown',
    }))
  }

  finalize(outcome: string, summary?: TraceSummary): void {
    this.db.run(`UPDATE trace_runs SET ended_at = ?, outcome = ?, summary_json = ? WHERE run_id = ?`, [Date.now(), outcome, summary ? JSON.stringify(summary) : null, this.runId])
  }
}
