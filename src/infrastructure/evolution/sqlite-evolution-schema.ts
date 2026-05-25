import type { Database } from 'bun:sqlite'
import type { MigrationStep } from '../_sqlite/connection'

export const evolutionMigrations: MigrationStep[] = [
  { version: 1, up(db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS proposals (
      id           TEXT PRIMARY KEY,
      type         TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      payload_json TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      decided_at   INTEGER,
      decided_by   TEXT
    )`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_proposals_status_time ON proposals(status, created_at DESC)`)

    db.run(`CREATE TABLE IF NOT EXISTS skill_stats (
      name              TEXT PRIMARY KEY,
      call_count        INTEGER NOT NULL DEFAULT 0,
      success_count     INTEGER NOT NULL DEFAULT 0,
      fail_count        INTEGER NOT NULL DEFAULT 0,
      last_used_at      INTEGER,
      total_duration_ms INTEGER NOT NULL DEFAULT 0,
      payload_json      TEXT
    )`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_stats_lastused ON skill_stats(last_used_at DESC)`)
    db.run(`CREATE INDEX IF NOT EXISTS idx_stats_calls    ON skill_stats(call_count DESC)`)
  }},
]
