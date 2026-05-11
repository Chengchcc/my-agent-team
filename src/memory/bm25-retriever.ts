import type { MemoryEntry, MemoryRetriever, MemoryStore } from './types';

export class BM25Retriever implements MemoryRetriever {
  constructor(
    private generalStore: MemoryStore & { ftsSearch?: (q: string, type: string, limit: number) => Promise<MemoryEntry[]> },
  ) {}

  async search(
    query: string,
    options: { limit?: number; threshold?: number } = {},
  ): Promise<MemoryEntry[]> {
    const { limit = 10 } = options;
    return this.generalStore.ftsSearch?.(query, 'general', limit) ?? [];
  }
}
