import type { Database } from 'bun:sqlite'
import type { SessionStore } from '../../application/ports/session-store'
import type { Session } from '../../domain/session'
import { createSession } from '../../domain/session'

export class SqliteSessionStore implements SessionStore {
  constructor(private db: Database) {}

  async save(session: Session): Promise<void> {
    this.db.run(
      `INSERT INTO sessions (id, agent_id, is_main, title, state, mode, created_at, last_active, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         agent_id    = excluded.agent_id,
         is_main     = excluded.is_main,
         title       = excluded.title,
         state       = excluded.state,
         mode        = excluded.mode,
         created_at  = excluded.created_at,
         last_active = excluded.last_active,
         meta_json   = excluded.meta_json`,
      [
        session.id, session.agentId, session.isMain ? 1 : 0,
        session.title ?? null, session.state ?? 'idle', session.mode ?? null,
        session.createdAt.getTime(), session.lastActiveAt.getTime(),
        null,
      ],
    )
  }

  async load(id: string): Promise<Session | null> {
    const row = this.db.query(
      `SELECT id, agent_id, is_main, title, state, mode, created_at, last_active
       FROM sessions WHERE id = ?`,
    ).get(id) as Record<string, unknown> | null
    if (!row) return null

    // Reconstruct via domain factory; pendingInputs/attachedFrontendIds are runtime-only
    const s = createSession(row.id as string, row.agent_id as string, Boolean(row.is_main), (row.title as string) ?? undefined)
    s.state = (row.state as Session['state']) ?? 'idle'
    s.mode = (row.mode as string) ?? 'normal'
    s.createdAt = new Date(row.created_at as number)
    s.lastActiveAt = new Date(row.last_active as number)
    return s
  }

  async list(agentId: string): Promise<Session[]> {
    const rows = this.db.query(
      `SELECT id, agent_id, is_main, title, state, mode, created_at, last_active
       FROM sessions WHERE agent_id = ? ORDER BY last_active DESC`,
    ).all(agentId) as Array<Record<string, unknown>>
    return rows.map(row => {
      const s = createSession(row.id as string, row.agent_id as string, Boolean(row.is_main), (row.title as string) ?? undefined)
      s.state = (row.state as Session['state']) ?? 'idle'
      s.mode = (row.mode as string) ?? 'normal'
      s.createdAt = new Date(row.created_at as number)
      s.lastActiveAt = new Date(row.last_active as number)
      return s
    })
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.run('DELETE FROM sessions WHERE id = ?', [id])
    return result.changes > 0
  }

  clear(): void {
    this.db.run('DELETE FROM sessions')
  }
}
