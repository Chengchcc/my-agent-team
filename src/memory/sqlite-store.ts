import { Database } from 'bun:sqlite';
import path from 'path';
import os from 'os';
import { mkdirSync, existsSync } from 'node:fs';
import crypto from 'crypto';
import type { MemoryEntry, MemoryStore, MemoryType, MemoryConfig } from './types';
import { getSettingsSync } from '../config';

const FALLBACK_MAX_SEMANTIC = 200;
const FALLBACK_MAX_EPISODIC = 500;

const FALLBACK_CONFIG: Required<MemoryConfig> = {
  globalBaseDir: '~/.my-agent/memory',
  maxSemanticEntries: FALLBACK_MAX_SEMANTIC,
  maxEpisodicEntries: FALLBACK_MAX_EPISODIC,
  consolidationThreshold: 50,
  autoExtractMinToolCalls: 3,
  maxInjectedEntries: 10,
  extractionModel: 'claude-3-haiku-20240307',
  retrievalThreshold: 0.75,
  retrievalTopK: 5,
  extractTriggerMode: 'explicit',
  maxUserPreferences: 20,
};

function getMemConfig(): Required<MemoryConfig> {
  try {
    const s = getSettingsSync();
    return s.memory as unknown as Required<MemoryConfig>;
  } catch {
    return FALLBACK_CONFIG;
  }
}

export class SqliteMemoryStore implements MemoryStore {
  private db: Database;
  private type: MemoryType;
  private config: Required<MemoryConfig>;

  constructor(
    type: MemoryType,
    config: MemoryConfig = {},
    projectPath?: string,
  ) {
    this.type = type;
    this.config = { ...getMemConfig(), ...config };

    const baseDir = this.expandDir(this.config.globalBaseDir);
    const dir = projectPath ? path.join(projectPath, '.my-agent') : baseDir;
    const dbPath = path.join(dir, 'memory.db');

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath, { create: true });
    this.db.run('PRAGMA journal_mode=WAL');
    this.db.run('PRAGMA busy_timeout=3000');
    this.initTables();
  }

  private expandDir(d: string): string {
    if (d.startsWith('~')) {
      return path.join(os.homedir(), d.slice(1));
    }
    return d;
  }

  private initTables(): void {
    this.db.run(`
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
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED,
        type UNINDEXED,
        text
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(projectPath)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_memory_created ON memory(created)');
  }

  private rowToEntry(row: any): MemoryEntry {
    const e: MemoryEntry = {
      id: row.id,
      type: row.type,
      text: row.text,
      created: row.created,
      weight: row.weight,
      source: row.source,
    };
    if (row.tags) e.tags = JSON.parse(row.tags);
    if (row.updated) e.updated = row.updated;
    if (row.projectPath) e.projectPath = row.projectPath;
    if (row.files) e.files = JSON.parse(row.files);
    if (row.metadata) e.metadata = JSON.parse(row.metadata);
    if (row.embedding) {
      const buf = row.embedding as Buffer;
      e.embedding = Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
    }
    if (row.lastHitAt != null) e.lastHitAt = row.lastHitAt;
    if (row.usageCount != null) e.usageCount = row.usageCount;
    return e;
  }

  async add(entry: Omit<MemoryEntry, 'id' | 'created'>): Promise<MemoryEntry> {
    const full: MemoryEntry = {
      ...entry,
      id: crypto.randomUUID(),
      created: new Date().toISOString(),
    };

    const embBuf = full.embedding
      ? Buffer.from(new Float32Array(full.embedding).buffer)
      : null;

    this.db.run(
      `INSERT INTO memory (id,type,text,tags,created,updated,weight,source,projectPath,files,metadata,embedding,lastHitAt,usageCount)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        full.id,
        full.type,
        full.text,
        full.tags ? JSON.stringify(full.tags) : null,
        full.created,
        full.updated ?? null,
        full.weight,
        full.source,
        full.projectPath ?? null,
        full.files ? JSON.stringify(full.files) : null,
        full.metadata ? JSON.stringify(full.metadata) : null,
        embBuf,
        full.lastHitAt ?? null,
        full.usageCount ?? 0,
      ],
    );

    // Sync FTS5
    this.db.run('INSERT INTO memory_fts (id, type, text) VALUES (?, ?, ?)', [
      full.id,
      full.type,
      full.text,
    ]);

    // Enforce capacity
    const max = this.type === 'semantic'
      ? this.config.maxSemanticEntries
      : this.config.maxEpisodicEntries;
    const cnt = (
      this.db.query('SELECT COUNT(*) as c FROM memory WHERE type=?').get(this.type) as any
    ).c;
    if (cnt > max) this.trimFifo(max);

    return full;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const row = this.db.query('SELECT * FROM memory WHERE id=?').get(id) as any;
    return row ? this.rowToEntry(row) : null;
  }

  async update(id: string, patch: Partial<MemoryEntry>): Promise<MemoryEntry | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    const merged = { ...existing, ...patch, updated: new Date().toISOString() } as MemoryEntry;
    const embBuf = merged.embedding
      ? Buffer.from(new Float32Array(merged.embedding).buffer)
      : null;

    this.db.run(
      `UPDATE memory SET text=?,tags=?,updated=?,weight=?,source=?,projectPath=?,files=?,metadata=?,embedding=?,lastHitAt=?,usageCount=? WHERE id=?`,
      [
        merged.text,
        merged.tags ? JSON.stringify(merged.tags) : null,
        merged.updated,
        merged.weight,
        merged.source,
        merged.projectPath ?? null,
        merged.files ? JSON.stringify(merged.files) : null,
        merged.metadata ? JSON.stringify(merged.metadata) : null,
        embBuf,
        merged.lastHitAt ?? null,
        merged.usageCount ?? 0,
        id,
      ],
    );

    // Sync FTS5
    this.db.run('DELETE FROM memory_fts WHERE id=?', [id]);
    this.db.run('INSERT INTO memory_fts (id, type, text) VALUES (?,?,?)', [
      merged.id,
      merged.type,
      merged.text,
    ]);

    return merged;
  }

  async remove(id: string): Promise<boolean> {
    const r = this.db.run('DELETE FROM memory WHERE id=? AND type=?', [id, this.type]);
    this.db.run('DELETE FROM memory_fts WHERE id=?', [id]);
    return r.changes > 0;
  }

  async getAll(): Promise<MemoryEntry[]> {
    const rows = this.db.query('SELECT * FROM memory WHERE type=?').all(this.type) as any[];
    return rows.map(r => this.rowToEntry(r));
  }

  async getByType(type: MemoryType): Promise<MemoryEntry[]> {
    const rows = this.db.query('SELECT * FROM memory WHERE type=?').all(type) as any[];
    return rows.map(r => this.rowToEntry(r));
  }

  async replaceAll(entries: MemoryEntry[], _type: MemoryType): Promise<void> {
    this.db.run('DELETE FROM memory WHERE type=?', [this.type]);
    this.db.run('DELETE FROM memory_fts WHERE type=?', [this.type]);

    const stmt = this.db.prepare(
      `INSERT INTO memory (id,type,text,tags,created,updated,weight,source,projectPath,files,metadata,embedding,lastHitAt,usageCount)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const ftsStmt = this.db.prepare('INSERT INTO memory_fts (id,type,text) VALUES (?,?,?)');

    for (const e of entries) {
      const embBuf = e.embedding
        ? Buffer.from(new Float32Array(e.embedding).buffer)
        : null;
      stmt.run(
        e.id, e.type, e.text, e.tags ? JSON.stringify(e.tags) : null,
        e.created, e.updated ?? null, e.weight, e.source,
        e.projectPath ?? null, e.files ? JSON.stringify(e.files) : null,
        e.metadata ? JSON.stringify(e.metadata) : null,
        embBuf, e.lastHitAt ?? null, e.usageCount ?? 0,
      );
      ftsStmt.run(e.id, e.type, e.text);
    }
  }

  async count(type?: MemoryType): Promise<number> {
    const t = type ?? this.type;
    const result = this.db.query('SELECT COUNT(*) as c FROM memory WHERE type=?').get(t) as any;
    return result.c;
  }

  async getRecent(limit: number, type?: MemoryType): Promise<MemoryEntry[]> {
    const t = type ?? this.type;
    const rows = this.db.query(
      'SELECT * FROM memory WHERE type=? ORDER BY created DESC LIMIT ?',
    ).all(t, limit) as any[];
    return rows.map(r => this.rowToEntry(r));
  }

  async enforceLimit(): Promise<void> {
    const max = this.type === 'semantic'
      ? this.config.maxSemanticEntries
      : this.config.maxEpisodicEntries;

    const cnt = (
      this.db.query('SELECT COUNT(*) as c FROM memory WHERE type=?').get(this.type) as any
    ).c;
    if (cnt > max) this.trimFifo(max);
  }

  async markHit(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    const now = Date.now();
    this.db.run(
      `UPDATE memory SET lastHitAt=?, usageCount=usageCount+1 WHERE id IN (${placeholders})`,
      [now, ...ids],
    );
  }

  async ftsSearch(query: string, type: string, limit: number): Promise<MemoryEntry[]> {
    const ftsQuery = query.replace(/[^\w\s\u4e00-\u9fa5]/g, ' ').trim();
    if (!ftsQuery) return [];
    const rows = this.db.query(`
      SELECT m.*, bm25(memory_fts) as bm25_score
      FROM memory m
      JOIN memory_fts f ON m.id = f.id
      WHERE f.type = ? AND memory_fts MATCH ?
      ORDER BY bm25_score
      LIMIT ?
    `).all(type, ftsQuery, limit) as any[];
    return rows.map(r => this.rowToEntry(r));
  }

  private trimFifo(max: number): void {
    this.db.run(
      `DELETE FROM memory WHERE type=? AND id NOT IN (
        SELECT id FROM memory WHERE type=? ORDER BY lastHitAt DESC, created DESC LIMIT ?
      )`,
      [this.type, this.type, max],
    );
    this.db.run(
      `DELETE FROM memory_fts WHERE type=? AND id NOT IN (
        SELECT id FROM memory WHERE type=?
      )`,
      [this.type, this.type],
    );
  }
}
