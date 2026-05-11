import type { MemoryEntry, MemoryRetriever, MemoryStore } from './types';

export interface VectorRetrieverConfig {
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
    options: {
      limit?: number;
      projectPath?: string;
      type?: 'semantic' | 'episodic' | 'project';
      threshold?: number;
    } = {},
  ): Promise<MemoryEntry[]> {
    const { limit = 10, threshold = 0.1, type } = options;

    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.encode(query);
    } catch {
      return [];
    }

    const candidates: MemoryEntry[] = [];
    if (!type || type === 'semantic') {
      candidates.push(...(await this.semanticStore.getAll()));
    }
    if (!type || type === 'episodic') {
      candidates.push(...(await this.episodicStore.getAll()));
    }

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
    const data = (await resp.json()) as { embeddings: number[][] };
    return data.embeddings[0];
  }

  cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}
