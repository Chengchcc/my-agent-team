import type { MemoryEntry, MemoryRetriever, MemoryStore } from './types';

const DEFAULT_LIMIT = 10;
const DEFAULT_THRESHOLD = 0.1;

export interface VectorRetrieverConfig {
  ollamaModel: string;
  ollamaBaseUrl: string;
}

export class VectorRetriever implements MemoryRetriever {
  private config: VectorRetrieverConfig;

  constructor(
    private generalStore: MemoryStore,
    config: Partial<VectorRetrieverConfig> = {},
  ) {
    this.config = {
      ollamaModel: config.ollamaModel ?? 'nomic-embed-text',
      ollamaBaseUrl: config.ollamaBaseUrl ?? 'http://localhost:11434',
    };
  }

  async search(
    query: string,
    options: { limit?: number; threshold?: number } = {},
  ): Promise<MemoryEntry[]> {
    const { limit = DEFAULT_LIMIT, threshold = DEFAULT_THRESHOLD } = options;

    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.encode(query);
    } catch {
      return [];
    }

    // Only load entries that have embeddings — pre-filtered at DB level
    const store = this.generalStore as MemoryStore & { getAllWithEmbeddings?: () => Promise<MemoryEntry[]> };
    const candidates = store.getAllWithEmbeddings
      ? await store.getAllWithEmbeddings()
      : (await this.generalStore.getAll()).filter(e => e.embedding);

    const scored = candidates
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
    const data = (await resp.json()) as { embeddings: number[][] };
    const emb = data.embeddings[0];
    if (!emb) throw new Error('Ollama returned empty embeddings');
    return emb;
  }

  cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const av = a[i]!;
      const bv = b[i]!;
      dot += av * bv;
      normA += av * av;
      normB += bv * bv;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}
