import type { MemoryEntry, MemoryRetriever, MemoryStore } from './types';

const DEFAULT_LIMIT = 10;

export interface VectorRetrieverConfig {
  ollamaModel: string;
  ollamaBaseUrl: string;
}

type VectorStore = MemoryStore & {
  vectorSearch?(queryEmbedding: number[], limit: number): Promise<Array<{ entryId: string; distance: number }>>;
  get?(id: string): Promise<MemoryEntry | null>;
};

export class VectorRetriever implements MemoryRetriever {
  private config: VectorRetrieverConfig;

  constructor(
    private store: VectorStore,
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
    const { limit = DEFAULT_LIMIT } = options;

    if (!this.store.vectorSearch) return [];

    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.encode(query);
    } catch {
      return [];
    }

    const rows = await this.store.vectorSearch(queryEmbedding, limit);
    const results: MemoryEntry[] = [];
    for (const row of rows) {
      const entry = await this.store.get?.(row.entryId) ?? null;
      if (entry) results.push(entry);
    }
    return results;
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
}
