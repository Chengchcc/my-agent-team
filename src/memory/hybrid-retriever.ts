import type { MemoryEntry, MemoryRetriever } from './types';

const RRF_K = 60;
const DEFAULT_VECTOR_WEIGHT = 0.5;
const DEFAULT_BM25_WEIGHT = 0.3;
const DEFAULT_KEYWORD_WEIGHT = 0.2;
const DEFAULT_LIMIT = 10;
const DEFAULT_THRESHOLD = 0;
const LIMIT_MULTIPLIER = 3;

export class HybridRetriever implements MemoryRetriever {
  private weights: { vector: number; bm25: number; keyword: number };

  constructor(
    private keywordRetriever: MemoryRetriever,
    private bm25Retriever: MemoryRetriever,
    private vectorRetriever: MemoryRetriever,
    weights?: Partial<{ vector: number; bm25: number; keyword: number }>,
  ) {
    this.weights = {
      vector: weights?.vector ?? DEFAULT_VECTOR_WEIGHT,
      bm25: weights?.bm25 ?? DEFAULT_BM25_WEIGHT,
      keyword: weights?.keyword ?? DEFAULT_KEYWORD_WEIGHT,
    };
  }

  async search(
    query: string,
    options: {
      limit?: number;
      projectPath?: string;
      type?: 'semantic' | 'episodic' | 'project';
      threshold?: number;
    } = {},
  ): Promise<MemoryEntry[]> {
    const { limit = DEFAULT_LIMIT, threshold = DEFAULT_THRESHOLD, ...rest } = options;
    const inflatedLimit = limit * LIMIT_MULTIPLIER;

    const [keywordRes, bm25Res, vectorRes] = await Promise.allSettled([
      this.keywordRetriever.search(query, { ...rest, limit: inflatedLimit }),
      this.bm25Retriever.search(query, { ...rest, limit: inflatedLimit }),
      this.vectorRetriever.search(query, { ...rest, limit: inflatedLimit }),
    ]);

    const keywordRanked = keywordRes.status === 'fulfilled' ? keywordRes.value : [];
    const bm25Ranked = bm25Res.status === 'fulfilled' ? bm25Res.value : [];
    const vectorRanked = vectorRes.status === 'fulfilled' ? vectorRes.value : [];

    const rrfScores = new Map<string, number>();
    const entryMap = new Map<string, MemoryEntry>();

    const addRRF = (entries: MemoryEntry[], weight: number) => {
      entries.forEach((entry, i) => {
        const rank = i + 1;
        const score = weight / (RRF_K + rank);
        rrfScores.set(entry.id, (rrfScores.get(entry.id) ?? 0) + score);
        if (!entryMap.has(entry.id)) {
          entryMap.set(entry.id, entry);
        }
      });
    };

    addRRF(keywordRanked, this.weights.keyword);
    addRRF(bm25Ranked, this.weights.bm25);
    addRRF(vectorRanked, this.weights.vector);

    const fused = [...rrfScores.entries()]
      .map(([id, score]) => ({ entry: entryMap.get(id)!, score }))
      .filter(s => s.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return fused.map(s => s.entry);
  }
}
