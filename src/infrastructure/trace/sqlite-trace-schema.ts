import type { Database } from 'bun:sqlite'
import type { MigrationStep } from '../_sqlite/connection'

export const traceMigrations: MigrationStep[] = [
  { version: 1, up(db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS trace_runs (
      run_id           TEXT PRIMARY KEY,
      session_id       TEXT NOT NULL,
      started_at       INTEGER NOT NULL,
      ended_at         INTEGER,
      outcome          TEXT,
      total_turns      INTEGER NOT NULL DEFAULT 0,
      total_tool_calls INTEGER NOT NULL DEFAULT 0,
      total_errors     INTEGER NOT NULL DEFAULT 0,
      tokens_in        INTEGER NOT NULL DEFAULT 0,
      tokens_out       INTEGER NOT NULL DEFAULT 0,
      summary_json     TEXT
    )`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_runs_session ON trace_runs(session_id, started_at DESC)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_runs_started ON trace_runs(started_at DESC)`)

    db.run(`CREATE TABLE IF NOT EXISTS trace_events (
      run_id       TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      turn_id      TEXT,
      kind         TEXT NOT NULL,
      ts           INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (run_id, seq),
      FOREIGN KEY (run_id) REFERENCES trace_runs(run_id) ON DELETE CASCADE
    )`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_events_run ON trace_events(run_id, seq)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_events_turn ON trace_events(turn_id)`)
  }},
]
