import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import os from 'os';
import { mkdirSync, existsSync } from 'node:fs';
import { initMemoryTables } from './sqlite-schema';
import crypto from 'crypto';
import type { MemoryEntry, MemoryStore, MemoryType, MemoryConfig } from './types';
import { getSettingsSync } from '../config';
import { configureSqlite } from '../utils/sqlite-platform';

configureSqlite();

type SqlRow = {
  id: string;
  type: string;
  text: string;
  created: string;
  weight: number;
  source: string;
  tags?: string;
  updated?: string;
  projectPath?: string;
  files?: string;
  metadata?: string;
  embedding?: Buffer;
  lastHitAt?: number;
  usageCount?: number;
  bm25_score?: number;
  c: number;
};

const FALLBACK_MAX_GENERAL = 500;
const EMBEDDING_DIMS = 768;
const EMBEDDING_FLOAT_SIZE = 4;
const MIN_TOKEN_LENGTH = 2;
const CANDIDATE_MULTIPLIER = 3;

const FALLBACK_CONFIG: Required<MemoryConfig> = {
  globalBaseDir: '~/.my-agent/memory',
  maxGeneralEntries: FALLBACK_MAX_GENERAL,
  consolidationThreshold: 50,
  autoExtractMinToolCalls: 3,
  maxInjectedEntries: 10,
  extractionModel: 'claude-3-haiku-20240307',
  retrievalThreshold: 0.75,
  retrievalTopK: 5,
  extractTriggerMode: 'explicit',
  maxUserPreferences: 20,
  preferenceWeightThreshold: 0.9,
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
    sqliteVec.load(this.db as unknown as { loadExtension(file: string, entrypoint?: string): void });
    initMemoryTables(this.db, EMBEDDING_DIMS);
  }

  private expandDir(d: string): string {
    if (d.startsWith('~')) {
      return path.join(os.homedir(), d.slice(1));
    }
    return d;
  }

  private rowToEntry(row: SqlRow): MemoryEntry {
    const e: MemoryEntry = {
      id: row.id,
      type: row.type as MemoryEntry['type'],
      text: row.text,
      created: row.created,
      weight: row.weight,
      source: row.source as MemoryEntry['source'],
    };
    if (row.tags) e.tags = JSON.parse(row.tags);
    if (row.updated) e.updated = row.updated;
    if (row.projectPath) e.projectPath = row.projectPath;
    if (row.files) e.files = JSON.parse(row.files);
    if (row.metadata) e.metadata = JSON.parse(row.metadata);
    if (row.embedding) {
      const buf = row.embedding as Buffer;
      e.embedding = Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / EMBEDDING_FLOAT_SIZE));
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

    // Enforce capacity (project stores have no individual limit, enforced by general limit)
    const max = this.type === 'general'
      ? this.config.maxGeneralEntries
      : this.config.maxGeneralEntries; // project shares general limit for now
    const cnt = (
      this.db.query('SELECT COUNT(*) as c FROM memory WHERE type=?').get(this.type) as SqlRow
    ).c;
    if (cnt > max) this.trimFifo(max);

    return full;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const row = this.db.query('SELECT * FROM memory WHERE id=?').get(id) as SqlRow;
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
    const rows = this.db.query('SELECT * FROM memory WHERE type=?').all(this.type) as SqlRow[];
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
    const result = this.db.query('SELECT COUNT(*) as c FROM memory WHERE type=?').get(t) as SqlRow;
    return result.c;
  }

  async getRecent(limit: number, type?: MemoryType): Promise<MemoryEntry[]> {
    const t = type ?? this.type;
    const rows = this.db.query(
      'SELECT * FROM memory WHERE type=? ORDER BY created DESC LIMIT ?',
    ).all(t, limit) as SqlRow[];
    return rows.map(r => this.rowToEntry(r));
  }

  async enforceLimit(): Promise<void> {
    const max = this.type === 'general'
      ? this.config.maxGeneralEntries
      : this.config.maxGeneralEntries;

    const cnt = (
      this.db.query('SELECT COUNT(*) as c FROM memory WHERE type=?').get(this.type) as SqlRow
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

  /** Pre-filter by text match — used by KeywordRetriever to avoid full scan. */
  async searchByText(query: string, limit: number): Promise<MemoryEntry[]> {
    const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length >= MIN_TOKEN_LENGTH);
    if (tokens.length === 0) {
      const rows = this.db.query(
        'SELECT * FROM memory WHERE type=? ORDER BY lastHitAt DESC, created DESC LIMIT ?',
      ).all(this.type, limit * CANDIDATE_MULTIPLIER) as SqlRow[];
      return rows.map(r => this.rowToEntry(r));
    }
    const conditions = tokens.map(() => 'text LIKE ?').join(' OR ');
    const params = tokens.map(t => `%${t}%`);
    const rows = this.db.query(
      `SELECT * FROM memory WHERE type=? AND (${conditions}) ORDER BY lastHitAt DESC, created DESC LIMIT ?`,
    ).all(this.type, ...params, limit * CANDIDATE_MULTIPLIER) as SqlRow[];
    return rows.map(r => this.rowToEntry(r));
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
    `).all(type, ftsQuery, limit) as SqlRow[];
    return rows.map(r => this.rowToEntry(r));
  }

  async storeEmbedding(entryId: string, embedding: number[]): Promise<void> {
    const vec = JSON.stringify(embedding);
    const sql = 'INSERT OR REPLACE INTO vec_memory(rowid, entry_id, embedding) VALUES ((SELECT rowid FROM memory WHERE id=?), ?, vec_f32(?))';
    this.db.run('BEGIN');
    try { this.db.run(sql, [entryId, entryId, vec]); this.db.run('COMMIT'); }
    catch (e) { this.db.run('ROLLBACK'); throw e; }
  }

  async vectorSearch(queryEmbedding: number[], limit: number): Promise<Array<{ entryId: string; distance: number }>> {
    const vec = JSON.stringify(queryEmbedding);
    const rows = this.db.query(`
      SELECT entry_id, distance
      FROM vec_memory
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(vec, limit) as Array<{ entryId: string; distance: number }>;
    return rows;
  }

  /** Backfill: find entries without embeddings, return up to batchSize. */
  async entriesWithoutEmbeddings(batchSize: number): Promise<Array<{ id: string; text: string }>> {
    const rows = this.db.query(`
      SELECT m.id, m.text
      FROM memory m
      LEFT JOIN vec_memory v ON m.id = v.entry_id
      WHERE m.type = ? AND v.entry_id IS NULL
      LIMIT ?
    `).all(this.type, batchSize) as Array<{ id: string; text: string }>;
    return rows;
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

  async close(): Promise<void> {
    this.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.close();
  }
}
