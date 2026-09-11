import type { EmbeddingProvider } from "./embeddings.js";
import {
  ftsMatchExpression,
  type MemoryRow,
  openVectorMemoryStore,
  queryHasCjk,
  type VectorMemoryStore,
} from "./vector-store.js";

/** Hybrid recall over the vector memory store (mnemopi beam scoring, ponytail
 *  cut): two voices — brute-force cosine over the stored embeddings and
 *  FTS5/LIKE keyword hits — fused with reciprocal rank fusion (RRF, K=60),
 *  then multiplied by hygiene factors (veracity weight, 72h recency decay).
 *  Superseded and expired memories are filtered out before ranking.
 *
 *  ponytail: exact scan in JS — at hundreds-to-thousands of rows this is
 *  sub-millisecond; the normalized-matrix shape leaves an ANN upgrade path
 *  if a real corpus ever makes it measurable. */

const RRF_K = 60;
const RECENCY_HALFLIFE_HOURS = 72;

export interface RecallHit {
  readonly id: string;
  readonly content: string;
  readonly context: string | null;
  readonly source: string | null;
  readonly score: number;
  readonly voiceScores: { vec?: number; fts?: number };
  readonly createdAt: string;
}

export interface RecallOptions {
  readonly topK?: number;
  /** 0 disables a voice (RRF then degenerates to the other ranking). */
  readonly vecWeight?: number;
  readonly ftsWeight?: number;
}

const VERACITY_WEIGHTS: Record<string, number> = {
  stated: 1.0,
  true: 1.0,
  likely_true: 1.0,
  unknown: 0.8,
  inferred: 0.7,
  false: 0,
};

function cosine(a: readonly number[], b: readonly number[]): number {
  // Stored vectors are normalized at embed time; dot product = cosine.
  // Guard anyway: renormalize defensively against JSON drift.
  let na = 0;
  let nb = 0;
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / Math.sqrt(na * nb);
}

function recencyDecay(timestamp: string | null | undefined): number {
  if (!timestamp) return 0.5;
  const t = Date.parse(timestamp);
  if (!Number.isFinite(t)) return 0.5;
  const ageHours = (Date.now() - t) / 3_600_000;
  if (ageHours <= 0) return 1;
  return 0.5 ** (ageHours / RECENCY_HALFLIFE_HOURS);
}

/** Maximal CJK runs (>=2 chars) and ASCII terms (>=2 chars) from a query,
 *  lowercased — the LIKE voice's needle set. */
export function needleSegments(query: string): string[] {
  const lower = query.toLowerCase();
  const segments: string[] = [];
  for (const m of lower.matchAll(/[\u4e00-\u9fff\u3040-\u30ff]{2,}/g)) {
    segments.push(m[0]);
  }
  for (const term of lower.split(/[^\p{L}\p{N}_-]+/u)) {
    if (
      term.length >= 2 &&
      !/[\u4e00-\u9fff\u3040-\u30ff]/.test(term) &&
      /\p{L}|\p{N}/u.test(term)
    ) {
      segments.push(term);
    }
  }
  return [...new Set(segments)];
}

function eligible(row: MemoryRow): boolean {
  if (row.supersededBy !== null) return false;
  if (row.validUntil !== null) {
    const until = Date.parse(row.validUntil);
    if (Number.isFinite(until) && until < Date.now()) return false;
  }
  return (VERACITY_WEIGHTS[row.veracity] ?? 0.8) > 0;
}

function ftsCandidates(store: VectorMemoryStore, query: string, limit: number): MemoryRow[] {
  const cjk = queryHasCjk(query);
  const match = ftsMatchExpression(query);
  // CJK (or a query with no ASCII terms): LIKE scan over live rows. The
  // corpus is small; correctness beats the FTS5 unicode61 blind spot.
  // Both paths yield only eligible rows: a superseded/expired/false memory
  // must never surface through any voice.
  const ok = (r: MemoryRow) => eligible(r);
  if (cjk || match === null) {
    // Segment the query: maximal CJK runs and ASCII terms. A whole-query
    // LIKE would miss any row that does not contain the query verbatim —
    // fatal for mixed zh+en queries ("husky 钩子教训" would never match).
    const needles = needleSegments(query);
    if (needles.length === 0) return [];
    const matches = (haystack: string) => needles.some((n) => haystack.includes(n));
    return store
      .all()
      .filter(
        (r) =>
          ok(r) &&
          (matches(r.content.toLowerCase()) ||
            (r.context ? matches(r.context.toLowerCase()) : false)),
      )
      .slice(0, limit);
  }
  return store.ftsSearch(match, limit).filter(ok);
}

export async function recallMemories(
  store: VectorMemoryStore,
  provider: EmbeddingProvider | null,
  query: string,
  opts: RecallOptions = {},
): Promise<RecallHit[]> {
  const topK = opts.topK ?? 8;
  const useVec = provider !== null && (opts.vecWeight ?? 1) > 0;
  const useFts = (opts.ftsWeight ?? 1) > 0;
  const rows = store.all().filter(eligible);
  if (rows.length === 0) return [];

  // Voice 1: exact cosine ranking.
  const vecRanking: Array<{ row: MemoryRow; score: number }> = [];
  if (useVec && provider) {
    let queryVec: number[] | null = null;
    try {
      queryVec = await provider.embedQuery(query);
    } catch {
      // Provider unavailable (model missing, ONNX failure): the FTS voice
      // still answers — degraded, never broken.
    }
    if (queryVec) {
      for (const row of rows) {
        if (!row.embedding || row.embedding.length !== queryVec.length) continue;
        const score = cosine(queryVec, row.embedding);
        if (score > 0.05) vecRanking.push({ row, score });
      }
      vecRanking.sort((a, b) => b.score - a.score);
    }
  }

  // Voice 2: keyword ranking (FTS5 bm25, or LIKE for CJK).
  const ftsRanking: Array<{ row: MemoryRow; score: number }> = [];
  if (useFts) {
    const hits = ftsCandidates(store, query, Math.max(50, topK * 5));
    // bm25 scores from SQLite are "smaller is better"; invert into (0,1].
    for (const hit of hits) ftsRanking.push({ row: hit, score: 1 });
    // LIKE path carries no magnitude; rank order = insertion order. The RRF
    // below only consumes ranks, so a constant score is fine.
  }

  // RRF fusion + hygiene multipliers.
  const rrf = new Map<string, { hit: RecallHit; score: number }>();
  const addVoice = (
    ranking: Array<{ row: MemoryRow; score: number }>,
    voice: "vec" | "fts",
    weight: number,
  ) => {
    if (weight <= 0) return;
    ranking.forEach((entry, idx) => {
      const contribution = (1 / (RRF_K + idx + 1)) * weight;
      const existing = rrf.get(entry.row.id);
      if (existing) {
        existing.score += contribution;
        existing.hit.voiceScores[voice] = entry.score;
      } else {
        rrf.set(entry.row.id, {
          score: contribution,
          hit: {
            id: entry.row.id,
            content: entry.row.content,
            context: entry.row.context,
            source: entry.row.source,
            score: contribution,
            voiceScores: { [voice]: entry.score },
            createdAt: entry.row.createdAt,
          },
        });
      }
    });
  };
  addVoice(vecRanking, "vec", opts.vecWeight ?? 1);
  addVoice(ftsRanking, "fts", opts.ftsWeight ?? 1);

  // A hit found by a later voice must still get its hygiene multipliers —
  // rebuild final scores once, after fusion.
  const fused = [...rrf.values()].flatMap((entry) => {
    const row = rows.find((r) => r.id === entry.hit.id);
    if (!row) return [];
    const veracity = VERACITY_WEIGHTS[row.veracity] ?? 0.8;
    const freshness = 0.7 + 0.3 * recencyDecay(row.createdAt);
    return { ...entry.hit, score: entry.score * veracity * freshness };
  });
  fused.sort((a, b) => b.score - a.score);
  const top = fused.slice(0, topK);
  if (top.length > 0) store.markRecalled(top.map((h) => h.id));
  return top;
}

/** Retain with embedding computed by the provider. Best-effort: when the
 *  provider fails the row lands WITHOUT an embedding (FTS still finds it);
 *  a later re-embed pass could backfill, none exists yet. */
export async function retainMemory(
  store: VectorMemoryStore,
  provider: EmbeddingProvider | null,
  input: { content: string; context?: string; source: string; importance?: number },
): Promise<string> {
  let embedding: readonly number[] | undefined;
  let model: string | undefined;
  if (provider) {
    try {
      embedding = (await provider.embedDocuments([input.content]))[0];
      model = provider.model;
    } catch {
      /* FTS-only row */
    }
  }
  return (
    store.retainIfNew({
      content: input.content,
      ...(input.context ? { context: input.context } : {}),
      source: input.source,
      ...(input.importance !== undefined ? { importance: input.importance } : {}),
      ...(embedding ? { embedding, embeddingModel: model } : {}),
    }) ??
    store.byContent(input.content)?.id ??
    ""
  );
}

export { openVectorMemoryStore };
