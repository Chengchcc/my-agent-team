# Hybrid Memory Retrieval — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** SQLite-backed three-way hybrid retrieval (keyword + FTS5 BM25 + Ollama vector) with RRF fusion. Extraction and embedding via evolution's PersistentQueue/Drainer/SettleBus. Extractor refactored to use structured trace data instead of raw messages.

**Tech Stack:** `bun:sqlite` + FTS5, Ollama `nomic-embed-text`, zero new npm deps

**Phase Breakdown:**

| Phase | Content | Key Deliverable |
|-------|---------|-----------------|
| P1: 底座 | Config + evolution task kinds + drainer quotas + trigger allowedKinds | 类型契约 + 队列能力 |
| P2: 存储+生产 | SqliteMemoryStore (FTS5) + LlmExtractor 改从 trace 读 + MemoryMiddleware 切队列 + drainer dispatcher | JSONL→SQLite，提取链路由队列驱动 |
| P3: 检索 | BM25Retriever + VectorRetriever (Ollama) + HybridRetriever (RRF) | 三路混合检索 |
| P4: 集成 | EmbeddingTaskRunner + runtime 接线 | 全链路打通 |
| P5: 验证 | 集成测试 + 全量回归 + 架构检查 | CI 通过 |

---

## P1: 底座

### Task 1.1: Add HybridRetrievalConfig

**Files:** Modify: `src/config/types.ts`, `src/config/schema.ts`

- [ ] **Step 1: Add type**
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

- [ ] **Step 2: Add schema**
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

### Task 1.2: Add mem-extract + mem-embed task kinds

**Files:** Modify: `src/evolution/types.ts`, `src/evolution/drainer.ts`, `src/evolution/triggers.ts`

- [ ] **Step 1: Add TaskKind** in `src/evolution/types.ts`:
```ts
// Extend TaskKind union:
| 'mem-extract'
| 'mem-embed'
```

- [ ] **Step 2: Add task data interfaces** in `src/evolution/types.ts`:
```ts
export interface MemExtractTaskData {
  kind: 'mem-extract';
  traceId: string;          // Read trace from TraceStore, not raw messages
  projectPath: string;
}

export interface MemEmbedTaskData {
  kind: 'mem-embed';
  entryId: string;
  text: string;
  storeType: 'semantic' | 'episodic' | 'project';
}
```

- [ ] **Step 3: Add drainer quotas** (same file, or in drainer.ts):
```ts
'mem-extract': 1,
'mem-embed': 3,
```

- [ ] **Step 4: Add allowedKinds to triggers**:
```ts
// EventTrigger.allowedKinds += ['mem-extract']     — fires on main_loop_settled
// IdleTrigger.allowedKinds += ['mem-embed']        — runs when agent is idle
```

- [ ] **Step 5: Verify & Commit**
```bash
bun run tsc --noEmit && git add src/evolution/
git commit -m "feat: add mem-extract and mem-embed task kinds to evolution queue"
```

---

## P2: 存储 + 生产

### Task 2.1: Write SqliteMemoryStore (bun:sqlite + FTS5)

**Files:** Create: `src/memory/sqlite-store.ts`, `tests/memory/sqlite-store.test.ts`

- [ ] **Step 1: Write failing test** — 11 tests covering: add/get/getAll/update/remove/count/getRecent/markHit/enforceLimit/embedding-store/FTS5-row-exists

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

// Fallback config (same as existing JsonlMemoryStore)
const FALLBACK_MAX_SEMANTIC = 200;
const FALLBACK_MAX_EPISODIC = 500;
const FALLBACK_CONFIG: Required<MemoryConfig> = {
  globalBaseDir: '~/.my-agent/memory', maxSemanticEntries: FALLBACK_MAX_SEMANTIC,
  maxEpisodicEntries: FALLBACK_MAX_EPISODIC, consolidationThreshold: 50,
  autoExtractMinToolCalls: 3, maxInjectedEntries: 10,
  extractionModel: 'claude-3-haiku-20240307', retrievalThreshold: 0.75,
  retrievalTopK: 5, extractTriggerMode: 'explicit', maxUserPreferences: 20,
};

function getMemConfig(): Required<MemoryConfig> {
  try { const s = getSettingsSync(); return s.memory as unknown as Required<MemoryConfig>; }
  catch { return FALLBACK_CONFIG; }
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
    this.db.run(`CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, text TEXT NOT NULL,
      tags TEXT, created TEXT NOT NULL, updated TEXT,
      weight REAL NOT NULL DEFAULT 0.8,
      source TEXT NOT NULL DEFAULT 'implicit',
      projectPath TEXT, files TEXT, metadata TEXT,
      embedding BLOB, lastHitAt INTEGER, usageCount INTEGER DEFAULT 0
    )`);
    this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      id UNINDEXED, type UNINDEXED, text
    )`);
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
    if (row.embedding) e.embedding = Array.from(new Float32Array(row.embedding as ArrayBuffer));
    if (row.lastHitAt != null) e.lastHitAt = row.lastHitAt;
    if (row.usageCount != null) e.usageCount = row.usageCount;
    return e;
  }

  async add(entry: Omit<MemoryEntry, 'id' | 'created'>): Promise<MemoryEntry> {
    const full: MemoryEntry = { ...entry, id: crypto.randomUUID(), created: new Date().toISOString() };
    const embBuf = full.embedding ? Buffer.from(new Float32Array(full.embedding).buffer) : null;
    this.db.run(`INSERT INTO memory (id,type,text,tags,created,updated,weight,source,projectPath,files,metadata,embedding,lastHitAt,usageCount) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [full.id, full.type, full.text, full.tags ? JSON.stringify(full.tags) : null,
       full.created, full.updated ?? null, full.weight, full.source,
       full.projectPath ?? null, full.files ? JSON.stringify(full.files) : null,
       full.metadata ? JSON.stringify(full.metadata) : null,
       embBuf, full.lastHitAt ?? null, full.usageCount ?? 0]);
    this.db.run('INSERT INTO memory_fts (id, type, text) VALUES (?, ?, ?)', [full.id, full.type, full.text]);
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
    this.db.run(`UPDATE memory SET text=?,tags=?,updated=?,weight=?,source=?,projectPath=?,files=?,metadata=?,embedding=?,lastHitAt=?,usageCount=? WHERE id=?`,
      [merged.text, merged.tags ? JSON.stringify(merged.tags) : null, merged.updated,
       merged.weight, merged.source, merged.projectPath ?? null,
       merged.files ? JSON.stringify(merged.files) : null,
       merged.metadata ? JSON.stringify(merged.metadata) : null,
       embBuf, merged.lastHitAt ?? null, merged.usageCount ?? 0, id]);
    this.db.run('DELETE FROM memory_fts WHERE id=?', [id]);
    this.db.run('INSERT INTO memory_fts (id, type, text) VALUES (?,?,?)', [merged.id, merged.type, merged.text]);
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
    const stmt = this.db.prepare(`INSERT INTO memory (id,type,text,tags,created,updated,weight,source,projectPath,files,metadata,embedding,lastHitAt,usageCount) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
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
    return (this.db.query('SELECT COUNT(*) as c FROM memory WHERE type=?').get(t) as any).c;
  }

  async getRecent(limit: number, type?: MemoryType): Promise<MemoryEntry[]> {
    const t = type ?? this.type;
    const rows = this.db.query('SELECT * FROM memory WHERE type=? ORDER BY created DESC LIMIT ?').all(t, limit) as any[];
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
    this.db.run(`UPDATE memory SET lastHitAt=?, usageCount=usageCount+1 WHERE id IN (${ph})`, [Date.now(), ...ids]);
  }

  async ftsSearch(query: string, type: string, limit: number): Promise<MemoryEntry[]> {
    const ftsQuery = query.replace(/[^\w\s\u4e00-\u9fa5]/g, ' ').trim();
    if (!ftsQuery) return [];
    const rows = this.db.query(`
      SELECT m.*, bm25(memory_fts) as bm25_score
      FROM memory m JOIN memory_fts f ON m.id = f.id
      WHERE f.type = ? AND memory_fts MATCH ?
      ORDER BY bm25_score LIMIT ?
    `).all(type, ftsQuery, limit) as any[];
    return rows.map(r => this.rowToEntry(r));
  }

  private trimFifo(max: number): void {
    this.db.run(`DELETE FROM memory WHERE type=? AND id NOT IN (
      SELECT id FROM memory WHERE type=? ORDER BY lastHitAt DESC, created DESC LIMIT ?)`, [this.type, this.type, max]);
    this.db.run(`DELETE FROM memory_fts WHERE type=? AND id NOT IN (
      SELECT id FROM memory WHERE type=?)`, [this.type, this.type]);
  }
}
```

- [ ] **Step 4: Run test → PASS** (11 tests)

- [ ] **Step 5: Commit**
```bash
git add src/memory/sqlite-store.ts tests/memory/sqlite-store.test.ts
git commit -m "feat: add SqliteMemoryStore with FTS5 full-text index"
```

### Task 2.2: Refactor LlmExtractor to use trace data

**Files:** Modify: `src/memory/extractor.ts`, `tests/memory/extractor.test.ts`

**Why:** Currently `extract(messages: Message[])` takes raw conversation messages. After this refactor, it takes a structured trace context (key events, tool results, user turns — already redacted and summarized by the trace system). This is the same data source evolution review uses.

- [ ] **Step 1: Update test** — Change test to pass structured trace-like input instead of raw Message[]:
```ts
// Old: extractor.extract(messages, projectPath)
// New: extractor.extract(traceContext, projectPath)
// Where traceContext has: { userTurns, toolCalls, outcomes, projectPath }
```

- [ ] **Step 2: Run test → FAIL**

- [ ] **Step 3: Refactor extract method signature and prompt**:

```ts
// New method signature
async extract(
  traceContext: {
    userTurns: Array<{ content: string; timestamp: string }>;
    toolCalls: Array<{ tool: string; summary: string; outcome: string }>;
    outcomes: Array<{ type: string; description: string }>;
  },
  projectPath?: string,
): Promise<MemoryEntry[]>
```

The prompt changes to use structured trace fields instead of raw conversation dump.

- [ ] **Step 4: Run test → PASS**

- [ ] **Step 5: Commit**
```bash
git add src/memory/extractor.ts tests/memory/extractor.test.ts
git commit -m "refactor: LlmExtractor uses trace context instead of raw messages"
```

### Task 2.3: Update MemoryMiddleware to enqueue instead of inline extract

**Files:** Modify: `src/memory/middleware.ts`, `tests/memory/middleware.test.ts`

- [ ] **Step 1: Update test** — Mock PersistentQueue, verify `mem-extract` enqueued with `traceId` (not raw messages)

- [ ] **Step 2: Run test → FAIL**

- [ ] **Step 3: Refactor** `afterAgentRun`:

```ts
// Before: inline extraction
if (shouldExtract) {
  const entries = await this.extractor.extract(messages, projectPath);
  for (const e of entries) {
    await store.add(e);
  }
}

// After: enqueue with traceId
if (shouldExtract && this.extractQueue) {
  const traceId = context.metadata.traceId;
  if (traceId) {
    await this.extractQueue.enqueue({
      kind: 'mem-extract',
      traceId,
      projectPath: process.cwd(),
    });
  }
}
// Fallback: if no queue configured, retain inline behavior for backward compat
```

Middleware becomes thin gatekeeper — checks trigger conditions, enqueues task. All extraction + storage work moves to drainer dispatcher.

- [ ] **Step 4: Run test → PASS**

- [ ] **Step 5: Commit**
```bash
git add src/memory/middleware.ts tests/memory/middleware.test.ts
git commit -m "refactor: MemoryMiddleware enqueues mem-extract via PersistentQueue"
```

### Task 2.4: Wire drainer dispatchers for mem-extract and mem-embed

**Files:** Modify: `src/evolution/drainer.ts`

- [ ] **Step 1: Write mem-extract dispatcher**:

```ts
async function dispatchMemExtract(task: MemExtractTaskData, ctx: DrainerContext): Promise<RunnerOutcome> {
  // 1. Read trace from TraceStore
  const trace = await ctx.traceStore.get(task.traceId);
  if (!trace) return { outcome: 'failed', error: 'trace not found' };

  // 2. Extract structured context from trace
  const traceContext = buildTraceContext(trace);

  // 3. Run extractor
  const extractor = new LlmExtractor(ctx.provider);
  const entries = await extractor.extract(traceContext, task.projectPath);

  // 4. Store entries
  const semanticStore = new SqliteMemoryStore('semantic');
  const episodicStore = new SqliteMemoryStore('episodic');
  const projectStore = new SqliteMemoryStore('project', {}, task.projectPath);

  for (const entry of entries) {
    const store = entry.type === 'semantic' ? semanticStore
      : entry.type === 'project' ? projectStore : episodicStore;
    const stored = await store.add(entry);
    // Enqueue embedding for this entry
    await ctx.queue.enqueue({
      kind: 'mem-embed',
      entryId: stored.id,
      text: stored.text,
      storeType: entry.type,
    });
  }

  // 5. Enforce limits
  await semanticStore.enforceLimit?.();
  await episodicStore.enforceLimit?.();

  return { outcome: 'completed' };
}
```

- [ ] **Step 2: Write mem-embed dispatcher** (stub — delegates to EmbeddingTaskRunner in P4):

```ts
async function dispatchMemEmbed(task: MemEmbedTaskData, ctx: DrainerContext): Promise<RunnerOutcome> {
  return ctx.embeddingRunner?.run(task) ?? { outcome: 'failed', error: 'no embedding runner' };
}
```

- [ ] **Step 3: Register dispatchers** in drainer's kind-to-dispatcher map

- [ ] **Step 4: Verify & Commit**
```bash
bun run tsc --noEmit && git add src/evolution/drainer.ts
git commit -m "feat: add drainer dispatchers for mem-extract and mem-embed"
```

---

## P3: 检索

### Task 3.1: Write BM25Retriever (FTS5-powered)

**Files:** Create: `src/memory/bm25-retriever.ts`, `tests/memory/bm25-retriever.test.ts`

- [ ] **Step 1: Write failing test** — 5 tests: exact match ranks first, no-match empty, limit, cross-store, Chinese text via FTS5 unicode61

- [ ] **Step 2: Run test → FAIL**

- [ ] **Step 3: Implement** — calls `store.ftsSearch(query, type, limit)`, deduplicates by id, preserves order

- [ ] **Step 4: Run test → PASS**

- [ ] **Step 5: Commit**

### Task 3.2: Write VectorRetriever (Ollama-powered)

**Files:** Create: `src/memory/vector-retriever.ts`, `tests/memory/vector-retriever.test.ts`

- [ ] **Step 1: Write failing test** — 5 tests: cosine similarity (identical/orthogonal/opposite), ranking, empty when Ollama unreachable

- [ ] **Step 2: Run test → FAIL**

- [ ] **Step 3: Implement** — `encode()` via `POST /api/embed`, `cosineSimilarity()` in JS, skips entries without embeddings

- [ ] **Step 4: Run test → PASS**

- [ ] **Step 5: Commit**

### Task 3.3: Write HybridRetriever

**Files:** Create: `src/memory/hybrid-retriever.ts`, `tests/memory/hybrid-retriever.test.ts`

- [ ] **Step 1: Write failing test** — 6 tests: fuse all three, shared entry higher score, dedup, vector failure fallback, limit, empty

- [ ] **Step 2: Run test → FAIL**

- [ ] **Step 3: Implement** — `Promise.allSettled` for 3 retrievers, RRF: `weight/(60+rank)`, weights: vector 0.5, bm25 0.3, keyword 0.2

- [ ] **Step 4: Run test → PASS**

- [ ] **Step 5: Commit**

---

## P4: 集成

### Task 4.1: Write EmbeddingTaskRunner

**Files:** Create: `src/memory/embedding-runner.ts`, `tests/memory/embedding-runner.test.ts`

- [ ] **Step 1: Write failing test** — 2 tests: encodes + updates store, returns failed on error

- [ ] **Step 2: Implement** — wraps `VectorRetriever.encode()`, updates store by type, returns `RunnerOutcome`

- [ ] **Step 3: Run test → PASS**

- [ ] **Step 4: Commit**

### Task 4.2: Update exports + wire runtime.ts

**Files:** Modify: `src/memory/index.ts`, `src/runtime.ts`

- [ ] **Step 1: Update exports** — export SqliteMemoryStore, BM25Retriever, VectorRetriever, HybridRetriever, EmbeddingTaskRunner

- [ ] **Step 2: Wire runtime.ts** — In `setupMemory()`:
  - `JsonlMemoryStore` → `SqliteMemoryStore`
  - `new KeywordRetriever(...)` → `new HybridRetriever(keywordRet, bm25Ret, vectorRet)`
  - Pass `PersistentQueue` to `MemoryMiddleware`
  - Pass `EmbeddingTaskRunner` to drainer context

- [ ] **Step 3: Verify compilation** — `bun run tsc --noEmit`

- [ ] **Step 4: Run memory tests** — `bun test tests/memory/`

- [ ] **Step 5: Commit**

---

## P5: 验证

### Task 5: Final verification

- [ ] **Step 1: Integration test** — keyword+BM25 combined with real SqliteMemoryStore, mock vector

- [ ] **Step 2: Run full memory suite** — `bun test tests/memory/`

- [ ] **Step 3: Run full project suite** — `bun test`

- [ ] **Step 4: Type check** — `bun run tsc --noEmit`

- [ ] **Step 5: Architecture check** — `bun run check:arch`
