# Hybrid Memory Retrieval — Design Spec

## Goal

Upgrade memory retrieval from JSONL keyword-only to SQLite-backed three-way hybrid (keyword + BM25 + vector) with RRF fusion. BM25 via SQLite FTS5. Embeddings via Ollama local model. Memory extraction and embedding generation use the evolution system's PersistentQueue + Drainer + SettleBus for async background processing.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    SettleBus                              │
│  main_loop_settled ─→ EventTrigger ─→ Drainer           │
└──────────────────────────┬───────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              │                         │
    ┌─────────▼──────┐       ┌─────────▼──────┐
    │ evolution tasks│       │  memory tasks   │
    │ tier0/2/3/HS   │       │  mem-extract    │
    │                │       │  mem-embed      │
    └────────────────┘       └────────────────┘
              │                         │
              └────────────┬────────────┘
                           │
                   ┌───────▼────────┐
                   │ PersistentQueue │
                   │ (file-per-task) │
                   └────────────────┘
                           │
                   ┌───────▼────────┐
                   │   Drainer       │
                   │ quota per kind  │
                   └────────────────┘

Retrieval path (synchronous):
                   ┌─────────────────┐
                   │ HybridRetriever  │
                   │ RRF: 0.5v/0.3b/ │
                   │      0.2k       │
                   └────────┬────────┘
          ┌─────────────────┼─────────────────┐
          │                 │                 │
    ┌─────▼─────┐   ┌──────▼──────┐   ┌──────▼──────┐
    │KeywordRet. │   │BM25Ret.(FTS5)│  │VectorRet.   │
    │(unchanged) │   │              │  │(Ollama API) │
    └────────────┘   └──────────────┘   └─────────────┘
          │                 │                 │
          └─────────────────┼─────────────────┘
                            │
                   ┌────────▼────────┐
                   │SqliteMemoryStore │
                   │ (bun:sqlite)     │
                   │ + FTS5 vtable    │
                   └─────────────────┘
```

## Key Technology Choices

| Component | Choice | Reason |
|-----------|--------|--------|
| Storage | `bun:sqlite` | Built-in, zero deps |
| BM25 | FTS5 virtual table | Built into SQLite, efficient, unicode61 tokenizer handles CJK |
| Embeddings | Ollama `nomic-embed-text` | Lightweight (137M), good multilingual, simpler than ONNX |
| Vector storage | BLOB + JS cosine | sqlite-vec incompatible with bun:sqlite; JS cosine is <1ms for <1000 entries |
| Queue | Evolution's PersistentQueue + Drainer | Reuse existing reliability infrastructure |

## SQLite Schema

```sql
-- Main memory table
CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  tags TEXT,           -- JSON array
  created TEXT NOT NULL,
  updated TEXT,
  weight REAL NOT NULL DEFAULT 0.8,
  source TEXT NOT NULL DEFAULT 'implicit',
  projectPath TEXT,
  files TEXT,          -- JSON array
  metadata TEXT,       -- JSON object
  embedding BLOB,      -- Float32Array little-endian
  lastHitAt INTEGER,   -- unix ms
  usageCount INTEGER DEFAULT 0
);

-- FTS5 full-text index for BM25 retrieval
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  id UNINDEXED,
  type UNINDEXED,
  text
);

CREATE INDEX IF NOT EXISTS idx_memory_type ON memory(type);
CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(projectPath);
CREATE INDEX IF NOT EXISTS idx_memory_created ON memory(created);
```

## New Files

### `src/memory/sqlite-store.ts`
- Implements `MemoryStore` using `bun:sqlite`
- Creates both `memory` table and `memory_fts` FTS5 virtual table
- `add()`: inserts into `memory` AND `memory_fts`
- `update()`: deletes old FTS5 row, inserts new one
- `remove()`: deletes from both tables
- `getAll()`: `SELECT * FROM memory WHERE type = ?`
- Embedding as BLOB: `Buffer.from(new Float32Array(arr).buffer)`

### `src/memory/bm25-retriever.ts`
- Implements `MemoryRetriever`
- Uses FTS5 MATCH with `bm25()` ranking function
- Query: `SELECT m.*, bm25(memory_fts) as score FROM memory m JOIN memory_fts f ON m.id = f.id WHERE f.type = ? AND memory_fts MATCH ? ORDER BY score`
- No JS scoring logic — FTS5 handles everything
- Tokenization: FTS5 `unicode61` tokenizer handles both English words and CJK characters

### `src/memory/vector-retriever.ts`
- Implements `MemoryRetriever`
- `encode(text)`: calls Ollama HTTP API `POST /api/embed` with model `nomic-embed-text`
- `search()`: encodes query, loads candidates with embeddings from SQLite, computes cosine similarity in JS
- Lazy backfill: skips entries without embeddings (queue handles them)
- Graceful fallback: if Ollama is down, returns []

### `src/memory/hybrid-retriever.ts`
- Implements `MemoryRetriever`
- Three retrievers in `Promise.allSettled`, RRF fusion k=60
- Weights: vector 0.5, BM25 0.3, keyword 0.2

### `src/memory/embedding-runner.ts`
- `EmbeddingTaskRunner` — wraps `VectorRetriever.encode()` as queue-compatible runner
- Input: `{ entryId, text, storeType }`
- Output: updates store with embedding, returns RunnerOutcome
- Stateless: one Ollama call per task

## Modified Files

### `src/memory/middleware.ts`
- `afterAgentRun`: enqueues `mem-extract` to PersistentQueue instead of inline extract

### `src/evolution/types.ts`
- Add `'mem-extract' | 'mem-embed'` to TaskKind union

### `src/evolution/drainer.ts`
- Quotas: `mem-extract: 1`, `mem-embed: 3`
- Dispatcher for `mem-extract` → runs LlmExtractor, stores results, enqueues embeds
- Dispatcher for `mem-embed` → runs EmbeddingTaskRunner

### `src/evolution/triggers.ts`
- EventTrigger allowedKinds += `mem-extract`
- IdleTrigger allowedKinds += `mem-embed`

### `src/runtime.ts`
- `SqliteMemoryStore` replaces `JsonlMemoryStore`
- `HybridRetriever` replaces bare `KeywordRetriever`
- Pass `PersistentQueue` to `MemoryMiddleware`
- Wire `EmbeddingTaskRunner` into drainer

### `src/memory/index.ts` / `package.json`
- New exports, no new npm deps (Ollama is system-level)

## Ollama Setup (manual, one-time)

```bash
ollama pull nomic-embed-text
```

Default endpoint: `http://localhost:11434/api/embed`. Configurable via env `OLLAMA_HOST`.

## What Does NOT Change

- `KeywordRetriever` — zero modifications
- `MemoryRetriever` interface — unchanged
- `MemoryStore` interface — unchanged
- `MemoryTool` — unchanged
- `LlmExtractor` — internal logic unchanged
