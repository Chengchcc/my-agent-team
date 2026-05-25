import type { MemoryEntry } from '../../domain/memory-entry'
import type { MemoryStore } from '../../application/ports/memory-store'
import { MS_PER_DAY } from '../../application/constants/units'

// ── Lifecycle weighting constants ───────────────────────────────────────────

const LIFECYCLE_DECAY_HALF_LIFE_DAYS = 30
const LIFECYCLE_DECAY_HALF_LIFE_MS = LIFECYCLE_DECAY_HALF_LIFE_DAYS * MS_PER_DAY
const LIFECYCLE_USAGE_MAX_BONUS = 0.5
const LIFECYCLE_MERGED_BONUS = 1.1
const RECENCY_HALF_LIFE_BASE = 0.5
const LOG_USAGE_SCALE = 0.1

export interface Retriever {
  search(query: string, opts?: { limit?: number }): Promise<MemoryEntry[]>
}

export interface EmbeddingEncoder {
  encode(text: string): Promise<number[]>
}

// ─── KeywordRetriever (5-dim weighted scoring) ───

const KW_WEIGHTS = { keyword: 0.35, tag: 0.25, recency: 0.20, intrinsic: 0.10, usage: 0.10 } as const
const RECENCY_HALF_LIFE_DAYS = 30
const RECENCY_HALF_LIFE_MS = RECENCY_HALF_LIFE_DAYS * MS_PER_DAY
const USAGE_CAP = 10
const CAND_MULTIPLIER = 3
const CAND_MIN = 30

export class KeywordRetriever implements Retriever {
  constructor(private store: MemoryStore) {}
  async search(q: string, opts: { limit?: number } = {}): Promise<MemoryEntry[]> {
    const limit = opts.limit ?? 10
    const tokens = tokenize(q.toLowerCase())
    if (tokens.length === 0) return []
    const candidates = await this.store.search(q, { limit: Math.max(limit * CAND_MULTIPLIER, CAND_MIN) })
    return candidates
      .map(e => ({ e, s: scoreEntry(e, tokens) }))
      .filter(x => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map(x => x.e)
  }
}

// ─── Bm25Retriever ───

export class Bm25Retriever implements Retriever {
  constructor(private store: MemoryStore) {}
  search(q: string, opts: { limit?: number } = {}): Promise<MemoryEntry[]> {
    return this.store.ftsSearch(q, opts.limit ?? 10)
  }
}

// ─── VectorRetriever ───

export class VectorRetriever implements Retriever {
  constructor(private store: MemoryStore, private encoder: EmbeddingEncoder) {}
  async search(q: string, opts: { limit?: number } = {}): Promise<MemoryEntry[]> {
    try {
      const emb = await this.encoder.encode(q)
      const rows = await this.store.vectorSearch(emb, opts.limit ?? 10)
      return rows.map(r => r.entry)
    } catch {
      return []
    }
  }
}

// ─── HybridRetriever (RRF fusion) ───

export interface HybridWeights { vector: number; bm25: number; keyword: number }
const DEFAULT_WEIGHTS: HybridWeights = { vector: 0.5, bm25: 0.3, keyword: 0.2 }
const RRF_K = 60
const HYBRID_INFLATION_FACTOR = 3

export class HybridRetriever implements Retriever {
  constructor(
    private kw: Retriever,
    private bm: Retriever,
    private vec: Retriever,
    private weights: HybridWeights = DEFAULT_WEIGHTS,
    private store?: MemoryStore,
  ) {}
  async search(q: string, opts: { limit?: number } = {}): Promise<MemoryEntry[]> {
    const limit = opts.limit ?? 10
    const inflated = limit * HYBRID_INFLATION_FACTOR
    const [a, b, c] = await Promise.allSettled([
      this.kw.search(q, { limit: inflated }),
      this.bm.search(q, { limit: inflated }),
      this.vec.search(q, { limit: inflated }),
    ])
    const lists = [a, b, c].map(r => r.status === 'fulfilled' ? r.value : []) as MemoryEntry[][]
    const ws = [this.weights.keyword, this.weights.bm25, this.weights.vector]
    const scores = new Map<string, number>()
    const seen = new Map<string, MemoryEntry>()
    lists.forEach((list, i) => {
      list.forEach((e, idx) => {
        scores.set(e.id, (scores.get(e.id) ?? 0) + ws[i]! / (RRF_K + idx + 1))
        if (!seen.has(e.id)) seen.set(e.id, e)
      })
    })
    const ranked = [...scores.entries()]
      .map(([id, s]) => ({ entry: seen.get(id)!, score: s * lifecycleWeight(seen.get(id)!) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, limit)
    if (this.store && ranked.length > 0) void this.store.markHit(ranked.map(r => r.entry.id))
    return ranked.map(r => r.entry)
  }
}

// ─── Lifecycle weighting ─────────────────────────────────────────────────

function lifecycleWeight(entry: MemoryEntry): number {
  const idleMs = Date.now() - (entry.lastHitAt?.getTime() ?? entry.createdAt.getTime())
  const recencyWeight = Math.pow(RECENCY_HALF_LIFE_BASE, idleMs / LIFECYCLE_DECAY_HALF_LIFE_MS)
  const usageWeight = 1 + Math.min(
    LIFECYCLE_USAGE_MAX_BONUS,
    Math.log2(1 + (entry.usageCount ?? 0)) * LOG_USAGE_SCALE,
  )
  const mergedBonus = (entry.mergeCount ?? 0) > 0 ? LIFECYCLE_MERGED_BONUS : 1.0
  return recencyWeight * usageWeight * mergedBonus
}

// ─── Helpers ───

function tokenize(text: string): string[] {
  const out: string[] = []
  const re = /([a-z0-9]{2,})|([\u4e00-\u9fa5])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push((m[1] ?? m[2])!)
  return [...new Set(out)]
}

function scoreEntry(entry: MemoryEntry, qTokens: string[]): number {
  const eTokens = tokenize(entry.text.toLowerCase())
  const eTags = (entry.tags ?? []).map(t => t.toLowerCase())
  const kwHits = qTokens.filter(t => eTokens.some(et => et.includes(t) || t.includes(et))).length
  const tagHits = qTokens.filter(t => eTags.some(et => et.includes(t) || t.includes(et))).length
  if (kwHits === 0 && tagHits === 0) return 0
  const kwScore = kwHits / qTokens.length
  const tagScore = tagHits / qTokens.length
  const latestTs = Math.max(entry.lastHitAt?.getTime() ?? 0, entry.createdAt.getTime())
  const recencyScore = Math.exp(-(Date.now() - latestTs) / RECENCY_HALF_LIFE_MS)
  const usageScore = Math.min(entry.usageCount ?? 0, USAGE_CAP) / USAGE_CAP
  return (
    kwScore * KW_WEIGHTS.keyword +
    tagScore * KW_WEIGHTS.tag +
    recencyScore * KW_WEIGHTS.recency +
    entry.weight * KW_WEIGHTS.intrinsic +
    usageScore * KW_WEIGHTS.usage
  )
}
