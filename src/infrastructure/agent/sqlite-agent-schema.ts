import type { Database } from 'bun:sqlite'

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS agents (
  agent_id         TEXT PRIMARY KEY,
  display_name     TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  is_default       INTEGER NOT NULL DEFAULT 0,
  identity_mode    TEXT NOT NULL,
  identity_status  TEXT NOT NULL,
  identity_path    TEXT NOT NULL,
  bootstrap_path   TEXT,
  lark_config      TEXT,
  lark_enabled     INTEGER NOT NULL DEFAULT 0,
  lark_last_test_at INTEGER,
  lark_last_test_ok INTEGER
)`

const CREATE_INDEX = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_default
  ON agents(is_default) WHERE is_default = 1`

const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA foreign_keys = ON',
]

const LEGACY_COLUMNS: Record<string, string> = {
  lark_enabled: 'ALTER TABLE agents ADD COLUMN lark_enabled INTEGER NOT NULL DEFAULT 0',
  lark_last_test_at: 'ALTER TABLE agents ADD COLUMN lark_last_test_at INTEGER',
  lark_last_test_ok: 'ALTER TABLE agents ADD COLUMN lark_last_test_ok INTEGER',
}

export function migrate(db: Database): void {
  db.run(CREATE_TABLE)
  db.run(CREATE_INDEX)

  const cols = db.query('PRAGMA table_info(agents)').all() as Array<{ name: string }>
  const colNames = new Set(cols.map(c => c.name))

  for (const [col, sql] of Object.entries(LEGACY_COLUMNS)) {
    if (!colNames.has(col)) {
      db.run(sql)
    }
  }
}

export function applyPragmas(db: Database): { wal: boolean } {
  for (const pragma of PRAGMAS) {
    db.run(pragma)
  }
  const jm = (db.query('PRAGMA journal_mode').get() as { journal_mode: string })
  return { wal: jm.journal_mode === 'wal' }
}
