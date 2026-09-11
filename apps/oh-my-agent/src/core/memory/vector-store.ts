import { Database } from "bun:sqlite";

/** Vector memory store (mnemopi beam schema, ponytail cut): ONE table with
 *  the hygiene fields present from day one (veracity / recall_count /
 *  last_recalled / valid_until / superseded_by — adding metadata later is
 *  hard, adding rows is easy), an external-content FTS5 index kept in sync
 *  by triggers, and embeddings stored as JSON floats.
 *
 *  Deliberately absent (checklist scope): the working/episodic tier split
 *  and its sleep-consolidation, binary quantization (float JSON is fine at
 *  hundreds-to-thousands of rows), and the graph/fact voices. */

export interface MemoryRow {
  readonly id: string;
  readonly content: string;
  readonly context: string | null;
  readonly source: string | null;
  readonly importance: number;
  readonly veracity: string;
  readonly embedding: number[] | null;
  readonly embeddingModel: string | null;
  readonly recallCount: number;
  readonly lastRecalled: string | null;
  readonly validUntil: string | null;
  readonly supersededBy: string | null;
  readonly createdAt: string;
}

export interface RetainInput {
  readonly content: string;
  readonly context?: string;
  /** Where it came from: "learn" | "autonomous" | "retain" | "backfill". */
  readonly source: string;
  readonly importance?: number;
  readonly veracity?: string;
  readonly embedding?: readonly number[];
  readonly embeddingModel?: string;
}

export interface VectorMemoryStore {
  retain(input: RetainInput): string;
  /** Idempotent upsert by normalized content: returns null when an
   *  equivalent memory already exists (dedup, mnemopi normalizeFact). */
  retainIfNew(input: RetainInput): string | null;
  byContent(content: string): MemoryRow | null;
  count(): number;
  all(): MemoryRow[];
  markRecalled(ids: readonly string[]): void;
  /** FTS5 bm25 search over the content/context index (ranked, best first). */
  ftsSearch(match: string, limit: number): MemoryRow[];
  supersede(id: string, byId: string): boolean;
  close(): void;
}

const COLUMNS =
  "id, content, context, source, importance, veracity, embedding_json, embedding_model, recall_count, last_recalled, valid_until, superseded_by, created_at";

interface RawRow {
  id: string;
  content: string;
  context: string | null;
  source: string | null;
  importance: number;
  veracity: string;
  embedding_json: string | null;
  embedding_model: string | null;
  recall_count: number;
  last_recalled: string | null;
  valid_until: string | null;
  superseded_by: string | null;
  created_at: string;
}

function toRow(raw: RawRow): MemoryRow {
  return {
    id: raw.id,
    content: raw.content,
    context: raw.context,
    source: raw.source,
    importance: raw.importance,
    veracity: raw.veracity,
    embedding: raw.embedding_json ? (JSON.parse(raw.embedding_json) as number[]) : null,
    embeddingModel: raw.embedding_model,
    recallCount: raw.recall_count,
    lastRecalled: raw.last_recalled,
    validUntil: raw.valid_until,
    supersededBy: raw.superseded_by,
    createdAt: raw.created_at,
  };
}

export function normalizeMemoryContent(content: string): string {
  return content.trim().replace(/\s+/g, " ").toLowerCase();
}

export function openVectorMemoryStore(dbPath: string): VectorMemoryStore {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      context TEXT,
      source TEXT,
      importance REAL NOT NULL DEFAULT 0.5,
      veracity TEXT NOT NULL DEFAULT 'stated',
      embedding_json TEXT,
      embedding_model TEXT,
      recall_count INTEGER NOT NULL DEFAULT 0,
      last_recalled TIMESTAMP,
      valid_until TIMESTAMP,
      superseded_by TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content, context, content='memories', content_rowid='rowid'
    )
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, context)
      VALUES (new.rowid, new.content, new.context);
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, context)
      VALUES ('delete', old.rowid, old.content, old.context);
    END
  `);
  // ponytail: no UPDATE trigger — memories rows are immutable (supersede
  // writes superseded_by via a targeted statement that does not touch the
  // indexed columns); add one before ever editing content in place.

  const insertStmt = db.prepare(
    `INSERT INTO memories (id, content, context, source, importance, veracity, embedding_json, embedding_model)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byContentStmt = db.prepare(
    `SELECT ${COLUMNS} FROM memories WHERE id = (SELECT id FROM memories WHERE content = ? LIMIT 1)`,
  );
  const allStmt = db.prepare(`SELECT ${COLUMNS} FROM memories ORDER BY created_at DESC`);
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM memories");
  const markStmt = db.prepare(
    `UPDATE memories SET recall_count = recall_count + 1,
       last_recalled = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`,
  );
  const ftsColumns = COLUMNS.split(", ")
    .map((c) => `memories.${c}`)
    .join(", ");
  const ftsStmt = db.prepare(
    `SELECT ${ftsColumns} FROM memories_fts
     JOIN memories ON memories.rowid = memories_fts.rowid
     WHERE memories_fts MATCH ? ORDER BY bm25(memories_fts) LIMIT ?`,
  );
  const supersedeStmt = db.prepare(
    "UPDATE memories SET superseded_by = ? WHERE id = ? AND superseded_by IS NULL",
  );

  function runRetain(input: RetainInput): string {
    const id = `mem-${crypto.randomUUID()}`;
    insertStmt.run(
      id,
      input.content,
      input.context ?? null,
      input.source,
      input.importance ?? 0.5,
      input.veracity ?? "stated",
      input.embedding ? JSON.stringify(input.embedding) : null,
      input.embeddingModel ?? null,
    );
    return id;
  }

  return {
    retain: runRetain,
    retainIfNew(input) {
      const existing = byContentStmt.get(input.content) as RawRow | null;
      if (existing) return null;
      return runRetain(input);
    },
    byContent(content) {
      const raw = byContentStmt.get(content) as RawRow | null;
      return raw ? toRow(raw) : null;
    },
    count: () => (countStmt.get() as { n: number }).n,
    all: () => (allStmt.all() as RawRow[]).map(toRow),
    markRecalled(ids) {
      for (const id of ids) markStmt.run(id);
    },
    ftsSearch(match, limit) {
      const rows = ftsStmt.all(match, limit) as RawRow[];
      return rows.map(toRow);
    },
    supersede(id, byId) {
      return supersedeStmt.run(byId, id).changes > 0;
    },
    close: () => db.close(),
  };
}

/** FTS5 MATCH terms for a query: ASCII words OR-joined; CJK has no
 *  token boundaries under unicode61, so CJK-bearing queries fall back to a
 *  LIKE scan (mnemopi's hasCjk path). Exported for the recall layer. */
export function ftsMatchExpression(query: string): string | null {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((t) => t.length >= 2);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

export function queryHasCjk(query: string): boolean {
  return /[\u4e00-\u9fff\u3040-\u30ff]/.test(query);
}
