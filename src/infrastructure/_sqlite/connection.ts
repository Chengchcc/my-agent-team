import { Database } from 'bun:sqlite'
import { configureSqlite } from '../../utils/sqlite-platform'

const DEFAULT_PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA foreign_keys = ON',
]

export function openDb(path: string, opts?: { pragmas?: string[] }): Database {
  const db = new Database(path, { create: true })
  configureSqlite()
  for (const p of opts?.pragmas ?? DEFAULT_PRAGMAS) db.run(p)
  return db
}

export interface MigrationStep { version: number; up(db: Database): void }

const SCHEMA_VERSION_TABLE = '_schema_version'

export function runMigrations(db: Database, steps: MigrationStep[]): void {
  db.run(`CREATE TABLE IF NOT EXISTS ${SCHEMA_VERSION_TABLE} (version INTEGER PRIMARY KEY)`)
  const row = db.query(`SELECT COALESCE(MAX(version),0) as v FROM ${SCHEMA_VERSION_TABLE}`).get() as { v: number } | null
  const current = row?.v ?? 0
  for (const step of [...steps].sort((a, b) => a.version - b.version)) {
    if (step.version <= current) continue
    db.transaction(() => {
      step.up(db)
      db.run(`INSERT INTO ${SCHEMA_VERSION_TABLE} (version) VALUES (?)`, [step.version])
    })()
  }
}
