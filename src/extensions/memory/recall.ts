import type { MemoryStore } from '../../application/ports/memory-store'
import type { MemoryEntry } from '../../domain/memory-entry'
import { KeywordRetriever, Bm25Retriever, VectorRetriever, HybridRetriever } from './retrievers'
import type { EmbeddingEncoder, HybridWeights } from './retrievers'

const DEFAULT_HYBRID_WEIGHT_VECTOR = 0.5
const DEFAULT_HYBRID_WEIGHT_BM25 = 0.3
const DEFAULT_HYBRID_WEIGHT_KEYWORD = 0.2

export interface RecallAPI {
  search(query: string, opts?: { limit?: number }): Promise<MemoryEntry[]>
}

export function createRecall(
  store: MemoryStore,
  encoder: EmbeddingEncoder,
  weights?: Partial<HybridWeights>,
): RecallAPI {
  const kw = new KeywordRetriever(store)
  const bm = new Bm25Retriever(store)
  const vec = new VectorRetriever(store, encoder)
  const hybrid = new HybridRetriever(kw, bm, vec, {
    vector: weights?.vector ?? DEFAULT_HYBRID_WEIGHT_VECTOR,
    bm25: weights?.bm25 ?? DEFAULT_HYBRID_WEIGHT_BM25,
    keyword: weights?.keyword ?? DEFAULT_HYBRID_WEIGHT_KEYWORD,
  }, store)
  return { search: (q, opts) => hybrid.search(q, opts) }
}
