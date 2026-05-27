import type { Database } from 'bun:sqlite'
import type { SessionHistoryPort } from '../../application/ports/session-history'
import type { HistoryRecordV1 } from '../../application/contracts'

export class SqliteHistoryStore implements SessionHistoryPort {
  constructor(private db: Database) {}

  get(sessionId: string): HistoryRecordV1[] {
    const rows = this.db.query(
      'SELECT content_json FROM history WHERE session_id = ? ORDER BY seq',
    ).all(sessionId) as Array<{ content_json: string }>
    return rows.map(r => JSON.parse(r.content_json) as HistoryRecordV1)
  }

  async appendBatch(sessionId: string, msgs: HistoryRecordV1[]): Promise<void> {
    const maxRow = this.db.query(
      'SELECT COALESCE(MAX(seq), 0) as m FROM history WHERE session_id = ?',
    ).get(sessionId) as { m: number } | null
    let next = (maxRow?.m ?? 0) + 1

    this.db.transaction(() => {
      const insert = this.db.prepare(
        `INSERT INTO history (session_id, seq, role, content_json, usage_in, usage_out, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const m of msgs) {
        insert.run(sessionId, next++, m.role ?? 'user', JSON.stringify(m), null, null, m.ts ?? Date.now())
      }
    })()
  }

  async replace(sessionId: string, msgs: HistoryRecordV1[]): Promise<void> {
    this.db.transaction(() => {
      this.db.run('DELETE FROM history WHERE session_id = ?', [sessionId])
      if (msgs.length === 0) return
      const insert = this.db.prepare(
        `INSERT INTO history (session_id, seq, role, content_json, usage_in, usage_out, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      for (let i = 0; i < msgs.length; i++) {
        const m = msgs[i]!
        insert.run(sessionId, i + 1, m.role ?? 'user', JSON.stringify(m), null, null, m.ts ?? Date.now())
      }
    })()
  }

  async drop(sessionId: string): Promise<boolean> {
    let removed = false
    this.db.transaction(() => {
      const r1 = this.db.run('DELETE FROM history WHERE session_id = ?', [sessionId])
      const r2 = this.db.run('DELETE FROM sessions WHERE id = ?', [sessionId])
      removed = r1.changes > 0 || r2.changes > 0
    })()
    return removed
  }

  async clear(sessionId: string): Promise<void> {
    this.db.run('DELETE FROM history WHERE session_id = ?', [sessionId])
  }
}
