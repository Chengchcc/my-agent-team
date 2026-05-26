import type { Database } from 'bun:sqlite';

export function initMemoryTables(db: Database, embeddingDims: number): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      tags TEXT,
      created TEXT NOT NULL,
      updated TEXT,
      weight REAL NOT NULL DEFAULT 0.8,
      source TEXT NOT NULL DEFAULT 'implicit',
      lastHitAt INTEGER,
      usageCount INTEGER DEFAULT 0,
      text_hash TEXT,
      superseded_by TEXT REFERENCES memory(id),
      merge_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      id UNINDEXED,
      type UNINDEXED,
      text
    )
  `);
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory USING vec0(
    entry_id TEXT,
    embedding float[${embeddingDims}]
  )`);

  // ── Schema migration for existing DBs (ignore errors if columns already exist) ──
  for (const sql of [
    'ALTER TABLE memory ADD COLUMN text_hash TEXT',
    'ALTER TABLE memory ADD COLUMN superseded_by TEXT',
    'ALTER TABLE memory ADD COLUMN merge_count INTEGER NOT NULL DEFAULT 0',
  ]) {
    try { db.run(sql); } catch { /* column already exists — safe to skip */ }
  }

  // ── Drop legacy columns (ignore errors if already dropped) ──
  for (const sql of [
    'ALTER TABLE memory DROP COLUMN projectPath',
    'ALTER TABLE memory DROP COLUMN files',
    'ALTER TABLE memory DROP COLUMN metadata',
    'ALTER TABLE memory DROP COLUMN embedding',
  ]) {
    try { db.run(sql); } catch { /* column already dropped — safe to skip */ }
  }

  // Migration: clean up empty-string superseded_by values
  db.run("UPDATE memory SET superseded_by = NULL WHERE superseded_by = ''");

  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_text_hash ON memory(text_hash) WHERE superseded_by IS NULL');
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_superseded ON memory(superseded_by)');
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type)');
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_created ON memory(created)');
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_type_text ON memory(type, text)');
}
