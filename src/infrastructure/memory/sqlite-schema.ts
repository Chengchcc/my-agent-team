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
      projectPath TEXT,
      files TEXT,
      metadata TEXT,
      embedding BLOB,
      lastHitAt INTEGER,
      usageCount INTEGER DEFAULT 0
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
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type)');
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(projectPath)');
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_created ON memory(created)');
}
