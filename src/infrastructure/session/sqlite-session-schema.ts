import type { Database } from 'bun:sqlite'
import type { MigrationStep } from '../_sqlite/connection'

export const sessionMigrations: MigrationStep[] = [
  { version: 1, up(db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL,
      is_main      INTEGER NOT NULL DEFAULT 0,
      title        TEXT,
      state        TEXT NOT NULL DEFAULT 'idle',
      mode         TEXT,
      created_at   INTEGER NOT NULL,
      last_active  INTEGER NOT NULL,
      meta_json    TEXT
    )`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id, last_active DESC)`)

    db.run(`CREATE TABLE IF NOT EXISTS history (
      session_id   TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      role         TEXT NOT NULL,
      content_json TEXT NOT NULL,
      usage_in     INTEGER,
      usage_out    INTEGER,
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_history_session ON history(session_id, seq)`)
  }},
]
