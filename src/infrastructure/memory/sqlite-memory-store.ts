import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import path from 'path';
import { mkdirSync, existsSync } from 'node:fs';
import { initMemoryTables } from './sqlite-schema';
import crypto from 'crypto';
import type { MemoryEntry, MemoryType } from '../../domain/memory-entry';
import type { MemoryStore } from '../../application/ports/memory-store';
import { configureSqlite } from '../../utils/sqlite-platform';

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
  embedding?: Buffer;
  lastHitAt?: number;
  usageCount?: number;
  bm25_score?: number;
};

const EMBEDDING_DIMS = 768;
const EMBEDDING_FLOAT_SIZE = 4;
const MIN_TOKEN_LENGTH = 2;
const CANDIDATE_MULTIPLIER = 3;
const DEFAULT_SQLITE_MEMORY_LIMIT = 50;

export class SqliteMemoryStore implements MemoryStore {
  private db: Database;
  private closed = false;

  constructor(baseDir: string) {
    const dir = baseDir;
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

  private rowToEntry(row: SqlRow): MemoryEntry {
    const e: MemoryEntry = {
      id: row.id,
      type: row.type as MemoryType,
      text: row.text,
      weight: row.weight,
      source: row.source as MemoryEntry['source'],
      tags: row.tags ? JSON.parse(row.tags) : [],
      createdAt: new Date(row.created),
      updatedAt: row.updated ? new Date(row.updated) : new Date(row.created),
      lastHitAt: row.lastHitAt != null ? new Date(row.lastHitAt) : undefined,
      usageCount: row.usageCount ?? 0,
    };
    if (row.embedding) {
      const buf = row.embedding as Buffer;
      e.embedding = Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / EMBEDDING_FLOAT_SIZE));
    }
    return e;
  }

  async add(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryEntry> {
    const full: MemoryEntry = {
      ...entry,
      id: crypto.randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
      tags: entry.tags ?? [],
      usageCount: entry.usageCount ?? 0,
      source: entry.source ?? 'explicit',
    } as MemoryEntry;

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
        full.createdAt.toISOString(),
        full.updatedAt.toISOString(),
        full.weight,
        full.source,
        null,  // projectPath — not in domain type
        null,  // files — not in domain type
        null,  // metadata — not in domain type
        embBuf,
        full.lastHitAt ? full.lastHitAt.getTime() : null,
        full.usageCount ?? 0,
      ],
    );

    // Sync FTS5
    this.db.run('INSERT INTO memory_fts (id, type, text) VALUES (?, ?, ?)', [
      full.id,
      full.type,
      full.text,
    ]);

    return full;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const row = this.db.query('SELECT * FROM memory WHERE id=?').get(id) as SqlRow;
    return row ? this.rowToEntry(row) : null;
  }

  async getAll(): Promise<MemoryEntry[]> {
    const rows = this.db.query('SELECT * FROM memory').all() as SqlRow[];
    return rows.map(r => this.rowToEntry(r));
  }

  async search(query: string, opts?: { limit?: number; threshold?: number }): Promise<MemoryEntry[]> {
    const limit = opts?.limit ?? 10;
    const threshold = opts?.threshold ?? 0;
    const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length >= MIN_TOKEN_LENGTH);

    let rows: SqlRow[];
    if (tokens.length === 0) {
      rows = this.db.query(
        'SELECT * FROM memory ORDER BY lastHitAt DESC, created DESC LIMIT ?',
      ).all(limit * CANDIDATE_MULTIPLIER) as SqlRow[];
    } else {
      const conditions = tokens.map(() => 'text LIKE ?').join(' OR ');
      const params = tokens.map(t => `%${t}%`);
      rows = this.db.query(
        `SELECT * FROM memory WHERE (${conditions}) ORDER BY lastHitAt DESC, created DESC LIMIT ?`,
      ).all(...params, limit * CANDIDATE_MULTIPLIER) as SqlRow[];
    }

    const entries = rows.map(r => this.rowToEntry(r));
    return entries.filter(e => e.weight >= threshold).slice(0, limit);
  }

  async update(
    id: string,
    patch: Partial<Pick<MemoryEntry, 'text' | 'weight' | 'tags'>>,
  ): Promise<MemoryEntry | null> {
    const existing = await this.get(id);
    if (!existing) return null;

    const merged = { ...existing, ...patch, updatedAt: new Date() } as MemoryEntry;

    this.db.run(
      `UPDATE memory SET text=?,tags=?,updated=?,weight=? WHERE id=?`,
      [
        merged.text,
        merged.tags ? JSON.stringify(merged.tags) : null,
        merged.updatedAt.toISOString(),
        merged.weight,
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
    const r = this.db.run('DELETE FROM memory WHERE id=?', [id]);
    this.db.run('DELETE FROM memory_fts WHERE id=?', [id]);
    return r.changes > 0;
  }

  async getByType(type: MemoryEntry['type'], limit?: number): Promise<MemoryEntry[]> {
    const rows = this.db.query(
      'SELECT * FROM memory WHERE type=? ORDER BY created DESC LIMIT ?',
    ).all(type, limit ?? DEFAULT_SQLITE_MEMORY_LIMIT) as SqlRow[];
    return rows.map(r => this.rowToEntry(r));
  }

  async ftsSearch(query: string, limit: number): Promise<MemoryEntry[]> {
    const ftsQuery = query.replace(/[^\w\s\u4e00-\u9fa5]/g, ' ').trim();
    if (!ftsQuery) return [];
    const rows = this.db.query(`
      SELECT m.*, bm25(memory_fts) as bm25_score
      FROM memory m
      JOIN memory_fts f ON m.id = f.id
      WHERE memory_fts MATCH ?
      ORDER BY bm25_score
      LIMIT ?
    `).all(ftsQuery, limit) as SqlRow[];
    return rows.map(r => this.rowToEntry(r));
  }

  async vectorSearch(queryEmbedding: number[], limit: number): Promise<Array<{ entry: MemoryEntry; distance: number }>> {
    const vec = JSON.stringify(queryEmbedding);
    const rows = this.db.query(`
      SELECT m.*, v.distance
      FROM vec_memory v
      JOIN memory m ON m.id = v.entry_id
      WHERE v.embedding MATCH ?
      ORDER BY v.distance
      LIMIT ?
    `).all(vec, limit) as Array<SqlRow & { distance: number }>;
    return rows.map(r => ({ entry: this.rowToEntry(r), distance: r.distance }));
  }

  async storeEmbedding(entryId: string, embedding: number[]): Promise<void> {
    const vec = JSON.stringify(embedding);
    const sql = 'INSERT OR REPLACE INTO vec_memory(rowid, entry_id, embedding) VALUES ((SELECT rowid FROM memory WHERE id=?), ?, vec_f32(?))';
    this.db.run('BEGIN');
    try { this.db.run(sql, [entryId, entryId, vec]); this.db.run('COMMIT'); }
    catch (e) { this.db.run('ROLLBACK'); throw e; }
  }

  async entriesWithoutEmbeddings(batchSize: number): Promise<Array<{ id: string; text: string }>> {
    const rows = this.db.query(`
      SELECT m.id, m.text
      FROM memory m
      LEFT JOIN vec_memory v ON m.id = v.entry_id
      WHERE v.entry_id IS NULL
      LIMIT ?
    `).all(batchSize) as Array<{ id: string; text: string }>;
    return rows;
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

  async clear(): Promise<void> {
    this.db.run('DELETE FROM memory');
    this.db.run('DELETE FROM memory_fts');
    this.db.run('DELETE FROM vec_memory');
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.close();
  }
}
