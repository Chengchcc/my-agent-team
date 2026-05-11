import type { MemoryEntry, MemoryRetriever, MemoryStore } from './types';

const DEFAULT_LIMIT = 10;

export class BM25Retriever implements MemoryRetriever {
  constructor(
    private generalStore: MemoryStore & { ftsSearch?: (q: string, type: string, limit: number) => Promise<MemoryEntry[]> },
  ) {}

  async search(
    query: string,
    options: { limit?: number; threshold?: number } = {},
  ): Promise<MemoryEntry[]> {
    const { limit = DEFAULT_LIMIT } = options;
    return this.generalStore.ftsSearch?.(query, 'general', limit) ?? [];
  }
}
