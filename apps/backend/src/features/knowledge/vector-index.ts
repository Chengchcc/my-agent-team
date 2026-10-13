/**
 * The knowledge pack's vector index: an on-disk file inside the pack directory
 * (`.embedding/index.json`) plus the maths to rank with it.
 *
 * Two deliberate properties.
 *
 * 1. All-or-nothing. The file is written to a temp sibling and renamed, so a
 *    half-written index cannot exist; the loaders treat anything they cannot
 *    parse, or that was built from a different model / pack revision, as
 *    stale. Since the index lives INSIDE the pack directory, the install
 *    pipeline's own atomic swap replaces it along with the content — a stale
 *    index cannot survive a pack refresh.
 * 2. Never silently truncate. An embedding model's context is a few hundred
 *    tokens, so "one vector per file" would quietly embed the head of a long
 *    page and call it indexed. Chunks are paragraph-sized instead, each one
 *    its own vector, and the file cap bounds how many.
 *
 * The transient states of a build (building / failed) are intentionally not
 * persisted: a crash leaves only a temp file, and a failure is reported to the
 * caller with its reason so the caller can say why it fell back to lexical.
 */
import {
  type Dirent,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const INDEX_DIR = ".embedding";
export const INDEX_FILE = "index.json";

/** Chunk size in characters. Roughly a paragraph, comfortably inside the
 *  context of the embedding models this box runs (~512 tokens). */
export const CHUNK_CHARS = 1_500;
/** Per-file chunk cap; bounds the cost of one oversized page. */
export const MAX_CHUNKS_PER_FILE = 200;
/** Chunks per embedding request. Measured 2026-10-13: one request carrying all
 *  1547 chunks of the shipped knowledge pack timed out after 30s, and the whole
 *  build is a one-off per pack revision, so it is batched rather than huge. */
export const EMBED_BATCH = 32;

export interface IndexChunk {
  /** `<pack-relative path>#<chunk index>` */
  id: string;
  path: string;
  text: string;
  vector: number[];
}

export interface VectorIndexFile {
  /** The `<provider>/<model>` this index was built with. A different one means
   *  a different vector space, and the vectors are not comparable. */
  model: string;
  dim: number;
  /** The pack revision the content came from (KnowledgePackRow.sourceRev),
   *  null when the caller has no database row (the MCP tool process). */
  sourceRev: string | null;
  /** Cheap content signature of the pack directory at build time. This is the
   *  staleness signal both callers can compute locally, so a changed pack is
   *  never ranked with stale vectors even where sourceRev is unknown. */
  signature: string;
  builtAt: number;
  chunks: IndexChunk[];
}

export type IndexState = "absent" | "ready" | "stale";

export interface IndexLookup {
  state: IndexState;
  index?: VectorIndexFile;
  /** Why it is not ready, for the caller to report. */
  reason?: string;
}

/** files:bytes:newest-mtime over the pack, skipping what listPages skips.
 *  A heuristic (a same-size, same-mtime edit slips through) but one both the
 *  backend and the MCP tool process can compute without a database row. */
export function contentSignature(root: string): string {
  let files = 0;
  let bytes = 0;
  let newest = 0;
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        try {
          const st = statSync(full);
          files += 1;
          bytes += st.size;
          newest = Math.max(newest, st.mtimeMs);
        } catch {
          /* unreadable: not part of the signature */
        }
      }
    }
  };
  walk(root);
  return `${files}:${bytes}:${Math.round(newest)}`;
}

export function indexFilePath(packDir: string): string {
  return join(packDir, INDEX_DIR, INDEX_FILE);
}

/** Split one page into embeddable chunks: blank-line paragraphs, and any
 *  paragraph longer than CHUNK_CHARS sliced on the character boundary. */
export function chunkText(
  text: string,
  path: string,
): Array<{ id: string; path: string; text: string }> {
  const out: Array<{ id: string; path: string; text: string }> = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    for (let offset = 0; offset < trimmed.length; offset += CHUNK_CHARS) {
      if (out.length >= MAX_CHUNKS_PER_FILE) {
        return out;
      }
      const slice = trimmed.slice(offset, offset + CHUNK_CHARS).trim();
      if (slice) out.push({ id: `${path}#${out.length}`, path, text: slice });
    }
  }
  return out;
}

export function readVectorIndex(
  packDir: string,
  expected: {
    model: string /** undefined = caller cannot know it (MCP process) */;
    sourceRev?: string | null;
  },
): IndexLookup {
  let raw: string;
  try {
    raw = readFileSync(indexFilePath(packDir), "utf8");
  } catch {
    return { state: "absent", reason: "no index built yet" };
  }
  let parsed: VectorIndexFile;
  try {
    parsed = JSON.parse(raw) as VectorIndexFile;
  } catch {
    return { state: "stale", reason: "index file is unreadable" };
  }
  if (parsed.model !== expected.model) {
    return {
      state: "stale",
      reason: `index was built with ${parsed.model}, now configured ${expected.model}`,
    };
  }
  const signature = contentSignature(packDir);
  if (parsed.signature !== signature) {
    return { state: "stale", reason: "pack content changed since the index was built" };
  }
  if (expected.sourceRev !== undefined && parsed.sourceRev !== expected.sourceRev) {
    return {
      state: "stale",
      reason: `index was built from revision ${parsed.sourceRev ?? "(none)"}, content is now ${expected.sourceRev ?? "(none)"}`,
    };
  }
  if (!Array.isArray(parsed.chunks) || parsed.chunks.length === 0) {
    return { state: "stale", reason: "index holds no chunks" };
  }
  return { state: "ready", index: parsed };
}

/** Build and atomically publish an index. Every failure comes back as
 *  `{ok: false, reason}`; nothing is written in that case. */
export async function buildVectorIndex(opts: {
  packDir: string;
  model: string;
  sourceRev: string | null;
  pages: ReadonlyArray<{ path: string; text: string }>;
  embed: (texts: readonly string[]) => Promise<number[][]>;
}): Promise<{ ok: true; index: VectorIndexFile } | { ok: false; reason: string }> {
  const wanted = opts.pages.flatMap((page) => chunkText(page.text, page.path));
  if (wanted.length === 0) {
    return { ok: false, reason: "pack has no readable text to embed" };
  }
  const vectors: number[][] = [];
  try {
    for (let i = 0; i < wanted.length; i += EMBED_BATCH) {
      const batch = wanted.slice(i, i + EMBED_BATCH).map((chunk) => chunk.text);
      const got = await opts.embed(batch);
      if (got.length !== batch.length) {
        return {
          ok: false,
          reason: `got ${got.length} vectors for ${batch.length} chunks in one batch`,
        };
      }
      vectors.push(...got);
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const dim = vectors[0]?.length ?? 0;
  if (dim === 0 || vectors.some((v) => v.length !== dim)) {
    return { ok: false, reason: "ragged or empty vectors" };
  }

  const index: VectorIndexFile = {
    model: opts.model,
    dim,
    sourceRev: opts.sourceRev,
    signature: contentSignature(opts.packDir),
    builtAt: Date.now(),
    chunks: wanted.map((chunk, i) => ({ ...chunk, vector: vectors[i] ?? [] })),
  };

  const dir = join(opts.packDir, INDEX_DIR);
  const tmp = join(dir, `index.${process.pid}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, JSON.stringify(index));
    renameSync(tmp, join(dir, INDEX_FILE));
  } catch (err) {
    rmSync(tmp, { force: true });
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, index };
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Best chunk per path, newest-best-first, capped. One file contributes once. */
export function rankByCosine(
  index: VectorIndexFile,
  query: readonly number[],
  limit: number,
): Array<{ path: string; score: number; text: string }> {
  const best = new Map<string, { path: string; score: number; text: string }>();
  for (const chunk of index.chunks) {
    const score = cosine(query, chunk.vector);
    const current = best.get(chunk.path);
    if (!current || score > current.score) {
      best.set(chunk.path, { path: chunk.path, score, text: chunk.text });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
