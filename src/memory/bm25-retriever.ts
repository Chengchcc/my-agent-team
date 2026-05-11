import type { MemoryEntry, MemoryRetriever, MemoryStore } from './types';

export class BM25Retriever implements MemoryRetriever {
  constructor(
    private semanticStore: MemoryStore & { ftsSearch?: (q: string, type: string, limit: number) => Promise<MemoryEntry[]> },
    private episodicStore: MemoryStore & { ftsSearch?: (q: string, type: string, limit: number) => Promise<MemoryEntry[]> },
    private projectStore: MemoryStore & { ftsSearch?: (q: string, type: string, limit: number) => Promise<MemoryEntry[]> },
  ) {}

  async search(
    query: string,
    options: { limit?: number; projectPath?: string; type?: 'semantic' | 'episodic' | 'project'; threshold?: number } = {},
  ): Promise<MemoryEntry[]> {
    const { limit = 10, type } = options;
    const results: MemoryEntry[] = [];

    if (!type || type === 'semantic') {
      const r = await this.semanticStore.ftsSearch?.(query, 'semantic', limit) ?? [];
      results.push(...r);
    }
    if (!type || type === 'episodic') {
      const r = await this.episodicStore.ftsSearch?.(query, 'episodic', limit) ?? [];
      results.push(...r);
    }

    const seen = new Set<string>();
    return results.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    }).slice(0, limit);
  }
}
