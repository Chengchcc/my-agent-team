# Hybrid Memory Retrieval — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** SQLite-backed three-way hybrid retrieval (keyword + FTS5 BM25 + Ollama vector) with RRF fusion. Embedding via async queue on evolution's PersistentQueue/Drainer/SettleBus.

**Tech Stack:** `bun:sqlite` + FTS5, Ollama `nomic-embed-text`, zero new npm deps

---

### Task 1: Add HybridRetrievalConfig

**Files:** Modify: `src/config/types.ts`, `src/config/schema.ts`

- [ ] **Step 1: Add type** in `src/config/types.ts`:
```ts
export interface HybridRetrievalConfig {
  enabled: boolean;
  ollamaModel: string;
  ollamaBaseUrl: string;
  vectorWeight: number;
  bm25Weight: number;
  keywordWeight: number;
}
```
Add `hybridRetrieval?: HybridRetrievalConfig` to `MemorySettings`.

- [ ] **Step 2: Add schema** in `src/config/schema.ts`:
```ts
const hybridRetrievalConfigSchema = z.object({
  enabled: z.boolean().default(true),
  ollamaModel: z.string().default('nomic-embed-text'),
  ollamaBaseUrl: z.string().default('http://localhost:11434'),
  vectorWeight: z.number().min(0).max(1).default(0.5),
  bm25Weight: z.number().min(0).max(1).default(0.3),
  keywordWeight: z.number().min(0).max(1).default(0.2),
});
```
Add to `memorySettingsSchema`.

- [ ] **Step 3: Verify & Commit**
```bash
bun run tsc --noEmit && git add src/config/types.ts src/config/schema.ts
git commit -m "feat: add HybridRetrievalConfig with Ollama settings"
```

---

### Task 2: Add mem-extract + mem-embed task kinds to evolution

**Files:** Modify: `src/evolution/types.ts`, `src/evolution/drainer.ts`, `src/evolution/triggers.ts`

- [ ] **Step 1: Add TaskKind** in `src/evolution/types.ts`:
```ts
// Extend TaskKind union:
| 'mem-extract'
| 'mem-embed'
```

- [ ] **Step 2: Add drainer quotas** in `src/evolution/drainer.ts`:
```ts
'mem-extract': 1,
'mem-embed': 3,
```

- [ ] **Step 3: Add allowedKinds** in `src/evolution/triggers.ts`:
```ts
// EventTrigger.allowedKinds += ['mem-extract']
// IdleTrigger.allowedKinds += ['mem-embed']
```

- [ ] **Step 4: Verify & Commit**
```bash
bun run tsc --noEmit && git add src/evolution/types.ts src/evolution/drainer.ts src/evolution/triggers.ts
git commit -m "feat: add mem-extract and mem-embed task kinds"
```

---

### Task 3: Write SqliteMemoryStore (bun:sqlite + FTS5)

**Files:** Create: `src/memory/sqlite-store.ts`, `tests/memory/sqlite-store.test.ts`

- [ ] **Step 1: Write failing test** — `tests/memory/sqlite-store.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SqliteMemoryStore } from '../../src/memory/sqlite-store';
import type { MemoryEntry } from '../../src/memory/types';
import fs from 'node:fs';

const TEST_DB = '/tmp/test-memory.db';
function cleanDb() {
  try { fs.unlinkSync(TEST_DB); } catch {}
  try { fs.unlinkSync(TEST_DB + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB + '-shm'); } catch {}
}

describe('SqliteMemoryStore', () => {
  beforeEach(cleanDb);
  afterEach(cleanDb);

  const entryData = {
    type: 'semantic' as const, text: 'user prefers vitest over jest',
    tags: ['testing'], weight: 0.9, source: 'explicit' as const,
  };

  it('adds and retrieves by id', async () => {
    const store = new SqliteMemoryStore('semantic', { globalBaseDir: '/tmp' });
    const entry = await store.add(entryData);
    const retrieved = await store.get(entry.id);
    expect(retrieved!.text).toBe(entryData.text);
    expect(retrieved!.tags).toEqual(['testing']);
  });

  it('returns null for missing id', async () => {
    const store = new SqliteMemoryStore('semantic', { globalBaseDir: '/tmp' });
    expect(await store.get('nonexistent')).toBeNull();
  });

  it('getAll filters by type', async () => {
    const sem = new SqliteMemoryStore('semantic', { globalBaseDir: '/tmp' });
    const epi = new SqliteMemoryStore('episodic', { globalBaseDir: '/tmp' });
    await sem.add({ ...entryData, text: 'sem fact' });
    await epi.add({ ...entryData, text: 'epi event', type: 'episodic' });
    expect(await sem.getAll()).toHaveLength(1);
    expect(await epi.getAll()).toHaveLength(1);
  });

  it('updates and removes', async () => {
    const store = new SqliteMemoryStore('semantic', { globalBaseDir: '/tmp' });
    const e = await store.add(entryData);
    const updated = await store.update(e.id, { text: 'changed' });
    expect(updated!.text).toBe('changed');
    expect(await store.remove(e.id)).toBe(true);
    expect(await store.getAll()).toHaveLength(0);
  });

  it('count and getRecent', async () => {
    const store = new SqliteMemoryStore('semantic', { globalBaseDir: '/tmp' });
    await store.add({ ...entryData, text: 'older' });
    await new Promise(r => setTimeout(r, 10));
    await store.add({ ...entryData, text: 'newer' });
    expect(await store.count()).toBe(2);
    const recent = await store.getRecent(2);
    expect(recent[0].text).toBe('newer');
  });

  it('markHit updates lastHitAt and usageCount', async () => {
    const store = new SqliteMemoryStore('semantic', { globalBaseDir: '/tmp' });
    const e = await store.add(entryData);
    await store.markHit([e.id]);
    const updated = await store.get(e.id);
    expect(updated!.lastHitAt).toBeDefined();
    expect(updated!.usageCount).toBe(1);
  });

  it('enforceLimit evicts oldest', async () => {
    const store = new SqliteMemoryStore('semantic', { globalBaseDir: '/tmp', maxSemanticEntries: 2 });
    await store.add({ ...entryData, text: 'e1' });
    await store.add({ ...entryData, text: 'e2' });
    await store.add({ ...entryData, text: 'e3' });
    expect(await store.count()).toBeLessThanOrEqual(2);
  });

  it('stores and retrieves embedding as number[]', async () => {
    const store = new SqliteMemoryStore('semantic', { globalBaseDir: '/tmp' });
    const emb = [0.1, 0.2, 0.3];
    const e = await store.add({ ...entryData, embedding: emb });
    expect((await store.get(e.id))!.embedding).toEqual(emb);
  });

  it('replaceAll and getByType', async () => {
    const store = new SqliteMemoryStore('semantic', { globalBaseDir: '/tmp' });
    await store.add({ ...entryData, text: 'old' });
    await store.replaceAll([{
      id: 'manual-id', type: 'semantic', text: 'new',
      created: new Date().toISOString(), weight: 1, source: 'explicit',
    }], 'semantic');
    expect(await store.getAll()).toHaveLength(1);
    expect((await store.getByType('semantic'))[0].text).toBe('new');
  });

  it('FTS5: text stored in FTS5 is searchable via raw SQL', async () => {
    const store = new SqliteMemoryStore('semantic', { globalBaseDir: '/tmp' });
    const e = await store.add({ ...entryData, text: 'user prefers pnpm' });
    // Verify FTS5 has the entry
    const db = (store as any).db;
    const row = db.query("SELECT * FROM memory_fts WHERE memory_fts MATCH 'pnpm'").get() as any;
    expect(row).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test → FAIL**

- [ ] **Step 3: Implement** `src/memory/sqlite-store.ts`:

```ts
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
  consolidationThreshold: 50, autoExtractMinToolCalls: 3,
  maxInjectedEntries: 10, extractionModel: 'claude-3-haiku-20240307',
  retrievalThreshold: 0.75, retrievalTopK: 5,
  extractTriggerMode: 'explicit', maxUserPreferences: 20,
};

function getMemConfig(): Required<MemoryConfig> {
  try {
    const s = getSettingsSync();
    return s.memory as unknown as Required<MemoryConfig>;
  } catch { return FALLBACK_CONFIG; }
}

export class SqliteMemoryStore implements MemoryStore {
  private db: Database;
  private type: MemoryType;
  private config: Required<MemoryConfig>;

  constructor(type: MemoryType, config: MemoryConfig = {}, projectPath?: string) {
    this.type = type;
    this.config = { ...getMemConfig(), ...config };
    const baseDir = this.expandDir(this.config.globalBaseDir);
    const dir = projectPath ? path.join(projectPath, '.my-agent') : baseDir;
    const dbPath = path.join(dir, 'memory.db');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.run('PRAGMA journal_mode=WAL');
    this.db.run('PRAGMA busy_timeout=3000');
    this.initTables();
  }

  private expandDir(d: string): string {
    return d.startsWith('~') ? path.join(os.homedir(), d.slice(1)) : d;
  }

  private initTables(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, text TEXT NOT NULL,
        tags TEXT, created TEXT NOT NULL, updated TEXT,
        weight REAL NOT NULL DEFAULT 0.8,
        source TEXT NOT NULL DEFAULT 'implicit',
        projectPath TEXT, files TEXT, metadata TEXT,
        embedding BLOB, lastHitAt INTEGER, usageCount INTEGER DEFAULT 0
      )
    `);
    this.db.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED, type UNINDEXED, text
      )
    `);
    this.db.run('CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(projectPath)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_memory_created ON memory(created)');
  }

  private rowToEntry(row: any): MemoryEntry {
    const e: MemoryEntry = {
      id: row.id, type: row.type, text: row.text,
      created: row.created, weight: row.weight, source: row.source,
    };
    if (row.tags) e.tags = JSON.parse(row.tags);
    if (row.updated) e.updated = row.updated;
    if (row.projectPath) e.projectPath = row.projectPath;
    if (row.files) e.files = JSON.parse(row.files);
    if (row.metadata) e.metadata = JSON.parse(row.metadata);
    if (row.embedding) {
      e.embedding = Array.from(new Float32Array(row.embedding as ArrayBuffer));
    }
    if (row.lastHitAt != null) e.lastHitAt = row.lastHitAt;
    if (row.usageCount != null) e.usageCount = row.usageCount;
    return e;
  }

  async add(entry: Omit<MemoryEntry, 'id' | 'created'>): Promise<MemoryEntry> {
    const full: MemoryEntry = {
      ...entry, id: crypto.randomUUID(), created: new Date().toISOString(),
    };
    const embBuf = full.embedding
      ? Buffer.from(new Float32Array(full.embedding).buffer) : null;
    this.db.run(
      `INSERT INTO memory (id,type,text,tags,created,updated,weight,source,projectPath,files,metadata,embedding,lastHitAt,usageCount)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [full.id, full.type, full.text, full.tags ? JSON.stringify(full.tags) : null,
       full.created, full.updated ?? null, full.weight, full.source,
       full.projectPath ?? null, full.files ? JSON.stringify(full.files) : null,
       full.metadata ? JSON.stringify(full.metadata) : null,
       embBuf, full.lastHitAt ?? null, full.usageCount ?? 0],
    );
    // Also insert into FTS5
    this.db.run('INSERT INTO memory_fts (id, type, text) VALUES (?, ?, ?)',
      [full.id, full.type, full.text]);
    // Enforce capacity
    const max = this.type === 'semantic' ? this.config.maxSemanticEntries : this.config.maxEpisodicEntries;
    const cnt = (this.db.query('SELECT COUNT(*) as c FROM memory WHERE type=?').get(this.type) as any).c;
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
    const embBuf = merged.embedding ? Buffer.from(new Float32Array(merged.embedding).buffer) : null;
    this.db.run(
      `UPDATE memory SET text=?,tags=?,updated=?,weight=?,source=?,projectPath=?,files=?,metadata=?,embedding=?,lastHitAt=?,usageCount=? WHERE id=?`,
      [merged.text, merged.tags ? JSON.stringify(merged.tags) : null, merged.updated,
       merged.weight, merged.source, merged.projectPath ?? null,
       merged.files ? JSON.stringify(merged.files) : null,
       merged.metadata ? JSON.stringify(merged.metadata) : null,
       embBuf, merged.lastHitAt ?? null, merged.usageCount ?? 0, id],
    );
    // Sync FTS5: delete old, insert new
    this.db.run('DELETE FROM memory_fts WHERE id=?', [id]);
    this.db.run('INSERT INTO memory_fts (id, type, text) VALUES (?,?,?)',
      [merged.id, merged.type, merged.text]);
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
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const ftsStmt = this.db.prepare('INSERT INTO memory_fts (id,type,text) VALUES (?,?,?)');
    for (const e of entries) {
      const embBuf = e.embedding ? Buffer.from(new Float32Array(e.embedding).buffer) : null;
      stmt.run(e.id, e.type, e.text, e.tags ? JSON.stringify(e.tags) : null,
        e.created, e.updated ?? null, e.weight, e.source,
        e.projectPath ?? null, e.files ? JSON.stringify(e.files) : null,
        e.metadata ? JSON.stringify(e.metadata) : null,
        embBuf, e.lastHitAt ?? null, e.usageCount ?? 0);
      ftsStmt.run(e.id, e.type, e.text);
    }
  }

  async count(type?: MemoryType): Promise<number> {
    const t = type ?? this.type;
    return ((this.db.query('SELECT COUNT(*) as c FROM memory WHERE type=?').get(t) as any).c);
  }

  async getRecent(limit: number, type?: MemoryType): Promise<MemoryEntry[]> {
    const t = type ?? this.type;
    const rows = this.db.query(
      'SELECT * FROM memory WHERE type=? ORDER BY created DESC LIMIT ?').all(t, limit) as any[];
    return rows.map(r => this.rowToEntry(r));
  }

  async enforceLimit(): Promise<void> {
    const max = this.type === 'semantic' ? this.config.maxSemanticEntries : this.config.maxEpisodicEntries;
    const cnt = (this.db.query('SELECT COUNT(*) as c FROM memory WHERE type=?').get(this.type) as any).c;
    if (cnt > max) this.trimFifo(max);
  }

  async markHit(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const ph = ids.map(() => '?').join(',');
    this.db.run(`UPDATE memory SET lastHitAt=?, usageCount=usageCount+1 WHERE id IN (${ph})`,
      [Date.now(), ...ids]);
  }

  private trimFifo(max: number): void {
    this.db.run(`
      DELETE FROM memory WHERE type=? AND id NOT IN (
        SELECT id FROM memory WHERE type=? ORDER BY lastHitAt DESC, created DESC LIMIT ?
      )`, [this.type, this.type, max]);
    this.db.run(`
      DELETE FROM memory_fts WHERE type=? AND id NOT IN (
        SELECT id FROM memory WHERE type=?
      )`, [this.type, this.type]);
  }
}
```

- [ ] **Step 4: Run test → PASS** (11 tests)

- [ ] **Step 5: Commit**
```bash
git add src/memory/sqlite-store.ts tests/memory/sqlite-store.test.ts
git commit -m "feat: add SqliteMemoryStore with FTS5 full-text index"
```

---

### Task 4: Write BM25Retriever (FTS5-powered)

**Files:** Create: `src/memory/bm25-retriever.ts`, `tests/memory/bm25-retriever.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'bun:test';
import type { MemoryEntry, MemoryStore } from '../../src/memory/types';
import { BM25Retriever } from '../../src/memory/bm25-retriever';

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return { id: 'test-id', type: 'semantic', text: 'test', weight: 1,
    source: 'explicit', created: new Date().toISOString(), ...overrides };
}

// Mock that simulates FTS5 MATCH behavior
class Fts5MockStore implements Partial<MemoryStore> {
  entries: MemoryEntry[] = [];
  getAll = vi.fn().mockImplementation(() => Promise.resolve(this.entries));
  // BM25Retriever calls ftsSearch on the store
  ftsSearch = vi.fn().mockImplementation(
    async (query: string, type: string, limit: number) => {
      const tokens = query.toLowerCase().split(/\s+/);
      return this.entries
        .filter(e => e.type === type && tokens.some(t => e.text.toLowerCase().includes(t)))
        .slice(0, limit);
    }
  );
}

describe('BM25Retriever', () => {
  let semanticStore: Fts5MockStore;
  let episodicStore: Fts5MockStore;
  let projectStore: Fts5MockStore;
  let retriever: BM25Retriever;

  beforeEach(() => {
    semanticStore = new Fts5MockStore();
    episodicStore = new Fts5MockStore();
    projectStore = new Fts5MockStore();
    retriever = new BM25Retriever(semanticStore as any, episodicStore as any, projectStore as any);
  });

  it('ranks exact match highest', async () => {
    semanticStore.entries = [
      makeEntry({ id: '1', text: 'user prefers vitest over jest' }),
      makeEntry({ id: '2', text: 'project uses react' }),
      makeEntry({ id: '3', text: 'vitest is a testing framework' }),
    ];
    const results = await retriever.search('vitest');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain('vitest');
  });

  it('returns empty for no matches', async () => {
    semanticStore.entries = [makeEntry({ text: 'unrelated' })];
    expect(await retriever.search('xyz')).toHaveLength(0);
  });

  it('respects limit', async () => {
    semanticStore.entries = Array(20).fill(null).map((_, i) =>
      makeEntry({ id: `${i}`, text: `typescript ${i}` }));
    const results = await retriever.search('typescript', { limit: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it('searches across semantic + episodic', async () => {
    semanticStore.entries = [makeEntry({ id: '1', text: 'dark mode pref', type: 'semantic' })];
    episodicStore.entries = [makeEntry({ id: '2', text: 'switched to dark mode', type: 'episodic' })];
    const results = await retriever.search('dark mode');
    expect(results).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test → FAIL**

- [ ] **Step 3: Implement** `src/memory/bm25-retriever.ts`:

```ts
import type { MemoryEntry, MemoryRetriever, MemoryStore } from './types';

export class BM25Retriever implements MemoryRetriever {
  constructor(
    private semanticStore: MemoryStore & { ftsSearch?: (q: string, type: string, limit: number) => Promise<MemoryEntry[]> },
    private episodicStore: MemoryStore & { ftsSearch?: (q: string, type: string, limit: number) => Promise<MemoryEntry[]> },
    private projectStore: MemoryStore & { ftsSearch?: (q: string, type: string, limit: number) => Promise<MemoryEntry[]> },
  ) {}

  async search(
    query: string,
    options: { limit?: number; projectPath?: string; type?: 'semantic' | 'episodic' | 'project'; threshold?: number } = {},
  ): Promise<MemoryEntry[]> {
    const { limit = 10, type } = options;
    const results: MemoryEntry[] = [];

    // FTS5 search — each store's ftsSearch runs MATCH query against its type
    if (!type || type === 'semantic') {
      const r = await this.semanticStore.ftsSearch?.(query, 'semantic', limit) ?? [];
      results.push(...r);
    }
    if (!type || type === 'episodic') {
      const r = await this.episodicStore.ftsSearch?.(query, 'episodic', limit) ?? [];
      results.push(...r);
    }

    // Dedup by id, preserve order
    const seen = new Set<string>();
    return results.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    }).slice(0, limit);
  }
}
```

And add `ftsSearch` method to `SqliteMemoryStore`:
```ts
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
```

- [ ] **Step 4: Run test → PASS**

- [ ] **Step 5: Commit**
```bash
git add src/memory/bm25-retriever.ts tests/memory/bm25-retriever.test.ts src/memory/sqlite-store.ts
git commit -m "feat: add BM25Retriever backed by FTS5 full-text search"
```

---

### Task 5: Write VectorRetriever (Ollama-powered)

**Files:** Create: `src/memory/vector-retriever.ts`, `tests/memory/vector-retriever.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'bun:test';
import type { MemoryEntry, MemoryStore } from '../../src/memory/types';
import { VectorRetriever } from '../../src/memory/vector-retriever';

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return { id: 'test-id', type: 'semantic', text: 'test', weight: 1,
    source: 'explicit', created: new Date().toISOString(), ...overrides };
}

class MockStore implements Partial<MemoryStore> {
  entries: MemoryEntry[] = [];
  getAll = vi.fn().mockImplementation(() => Promise.resolve(this.entries));
  update = vi.fn().mockResolvedValue(null);
}

describe('VectorRetriever', () => {
  let sem: MockStore; let epi: MockStore; let proj: MockStore;
  let retriever: VectorRetriever;

  beforeEach(() => {
    sem = new MockStore(); epi = new MockStore(); proj = new MockStore();
    retriever = new VectorRetriever(sem as any, epi as any, proj as any,
      { ollamaModel: 'test', ollamaBaseUrl: 'http://localhost:9999' });
  });

  it('cosine similarity: identical = 1', () => {
    const v = [0.5, 0.3, 0.1];
    expect((retriever as any).cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('cosine similarity: orthogonal = 0', () => {
    expect((retriever as any).cosineSimilarity([1,0,0], [0,1,0])).toBeCloseTo(0, 5);
  });

  it('ranks entries by embedding similarity', async () => {
    sem.entries = [
      makeEntry({ id: '1', text: 'relevant', embedding: [0.9, 0.1, 0] }),
      makeEntry({ id: '2', text: 'irrelevant', embedding: [0, 1, 0] }),
    ];
    (retriever as any).encode = vi.fn().mockResolvedValue([1, 0, 0]);
    const results = await retriever.search('test');
    expect(results[0].id).toBe('1');
  });

  it('skips entries without embeddings', async () => {
    sem.entries = [makeEntry({ id: '1', text: 'no emb' })];
    (retriever as any).encode = vi.fn().mockResolvedValue([1, 0, 0]);
    const results = await retriever.search('test');
    expect(results).toHaveLength(0); // skipped, not backfilled in search path
  });

  it('returns empty when Ollama is unreachable', async () => {
    sem.entries = [makeEntry({ id: '1', text: 'fact', embedding: [0.1, 0.2] })];
    // encode throws → returns []
    (retriever as any).encode = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const results = await retriever.search('test');
    expect(results).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test → FAIL**

- [ ] **Step 3: Implement** `src/memory/vector-retriever.ts`:

```ts
import type { MemoryEntry, MemoryRetriever, MemoryStore } from './types';

interface VectorRetrieverConfig {
  ollamaModel: string;
  ollamaBaseUrl: string;
}

export class VectorRetriever implements MemoryRetriever {
  private config: VectorRetrieverConfig;

  constructor(
    private semanticStore: MemoryStore,
    private episodicStore: MemoryStore,
    private projectStore: MemoryStore,
    config: Partial<VectorRetrieverConfig> = {},
  ) {
    this.config = {
      ollamaModel: config.ollamaModel ?? 'nomic-embed-text',
      ollamaBaseUrl: config.ollamaBaseUrl ?? 'http://localhost:11434',
    };
  }

  async search(
    query: string,
    options: { limit?: number; projectPath?: string;
      type?: 'semantic' | 'episodic' | 'project'; threshold?: number } = {},
  ): Promise<MemoryEntry[]> {
    const { limit = 10, threshold = 0.1, type } = options;

    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.encode(query);
    } catch {
      return []; // Ollama down → no vector results
    }

    const candidates: MemoryEntry[] = [];
    if (!type || type === 'semantic') candidates.push(...await this.semanticStore.getAll());
    if (!type || type === 'episodic') candidates.push(...await this.episodicStore.getAll());

    const scored = candidates
      .filter(e => e.embedding)
      .map(entry => ({
        entry,
        score: this.cosineSimilarity(queryEmbedding, entry.embedding!),
      }))
      .filter(s => s.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored.map(s => s.entry);
  }

  async encode(text: string): Promise<number[]> {
    const url = `${this.config.ollamaBaseUrl}/api/embed`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.config.ollamaModel, input: text }),
    });
    if (!resp.ok) throw new Error(`Ollama embed failed: ${resp.status}`);
    const data = await resp.json() as { embeddings: number[][] };
    return data.embeddings[0];
  }

  cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}
```

- [ ] **Step 4: Run test → PASS**

- [ ] **Step 5: Commit**
```bash
git add src/memory/vector-retriever.ts tests/memory/vector-retriever.test.ts
git commit -m "feat: add VectorRetriever using Ollama nomic-embed-text"
```

---

### Task 6: Write EmbeddingTaskRunner

**Files:** Create: `src/memory/embedding-runner.ts`, `tests/memory/embedding-runner.test.ts`

- [ ] **Step 1: Write test** — 2 tests: encodes + updates store; returns failed on error

- [ ] **Step 2: Run test → FAIL**

- [ ] **Step 3: Implement** — wraps `VectorRetriever.encode()`, updates the correct store by type, returns `RunnerOutcome`

- [ ] **Step 4: Run test → PASS**

- [ ] **Step 5: Commit**
```bash
git add src/memory/embedding-runner.ts tests/memory/embedding-runner.test.ts
git commit -m "feat: add EmbeddingTaskRunner for async embedding generation"
```

---

### Task 7: Write HybridRetriever

**Files:** Create: `src/memory/hybrid-retriever.ts`, `tests/memory/hybrid-retriever.test.ts`

- [ ] **Step 1: Write test** — 6 tests: fuse all three, shared entry ranks higher, dedup, vector failure fallback, limit, empty all

- [ ] **Step 2: Run test → FAIL**

- [ ] **Step 3: Implement** — `Promise.allSettled` for 3 retrievers, RRF: `weight/(60+rank)`, weights 0.5/0.3/0.2

- [ ] **Step 4: Run test → PASS**

- [ ] **Step 5: Commit**
```bash
git add src/memory/hybrid-retriever.ts tests/memory/hybrid-retriever.test.ts
git commit -m "feat: add HybridRetriever with three-way RRF fusion"
```

---

### Task 8: Update MemoryMiddleware to enqueue extraction

**Files:** Modify: `src/memory/middleware.ts`, `tests/memory/middleware.test.ts`

- [ ] **Step 1: Update test** — Mock PersistentQueue, verify `mem-extract` enqueued on trigger

- [ ] **Step 2: Run test → FAIL**

- [ ] **Step 3: Refactor** `afterAgentRun` — replace `extractor.extract()` with `queue.enqueue({ kind: 'mem-extract', ... })`

- [ ] **Step 4: Run test → PASS**

- [ ] **Step 5: Commit**
```bash
git add src/memory/middleware.ts tests/memory/middleware.test.ts
git commit -m "refactor: enqueue memory extraction via PersistentQueue"
```

---

### Task 9: Update exports + wire runtime.ts

**Files:** Modify: `src/memory/index.ts`, `src/runtime.ts`

- [ ] **Step 1: Update exports** — export all new classes
- [ ] **Step 2: Wire runtime.ts** — `SqliteMemoryStore` + `HybridRetriever` + queue pass to middleware
- [ ] **Step 3: Verify compilation** — `bun run tsc --noEmit`
- [ ] **Step 4: Run memory tests** — `bun test tests/memory/`
- [ ] **Step 5: Commit**
```bash
git add src/memory/index.ts src/runtime.ts
git commit -m "feat: wire hybrid retrieval with SQLite + FTS5 + Ollama"
```

---

### Task 10: Integration test + final verification

- [ ] **Step 1: Integration test** — keyword+BM25 combined with real SqliteMemoryStore
- [ ] **Step 2: Run full suite** — `bun test tests/memory/ && bun test`
- [ ] **Step 3: Type check** — `bun run tsc --noEmit`
- [ ] **Step 4: Architecture check** — `bun run check:arch`
