import { describe, it, expect, vi, beforeEach } from 'bun:test';
import type { MemoryEntry, MemoryStore } from '../../src/memory/types';
import { BM25Retriever } from '../../src/memory/bm25-retriever';

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: overrides.id ?? 'test-id',
    type: 'semantic',
    text: 'test',
    weight: 1,
    source: 'explicit',
    created: new Date().toISOString(),
    ...overrides,
  };
}

class Fts5MockStore implements Partial<MemoryStore> {
  entries: MemoryEntry[] = [];
  getAll = vi.fn().mockImplementation(() => Promise.resolve(this.entries));
  ftsSearch = vi.fn().mockImplementation(
    async (query: string, type: string, limit: number) => {
      const tokens = query.toLowerCase().split(/\s+/);
      return this.entries
        .filter(e => e.type === type && tokens.some(t => e.text.toLowerCase().includes(t)))
        .slice(0, limit);
    },
  );
}

describe('BM25Retriever', () => {
  let semanticStore: Fts5MockStore;
  let episodicStore: Fts5MockStore;
  let projectStore: Fts5MockStore;
  let retriever: BM25Retriever;

  beforeEach(() => {
    semanticStore = new Fts5MockStore();
    episodicStore = new Fts5MockStore();
    projectStore = new Fts5MockStore();
    retriever = new BM25Retriever(
      semanticStore as any,
      episodicStore as any,
      projectStore as any,
    );
  });

  it('ranks exact term match highest', async () => {
    semanticStore.entries = [
      makeEntry({ id: '1', text: 'user prefers vitest over jest', type: 'semantic' }),
      makeEntry({ id: '2', text: 'project uses react for UI', type: 'semantic' }),
      makeEntry({ id: '3', text: 'vitest is a testing framework', type: 'semantic' }),
    ];
    const results = await retriever.search('vitest');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain('vitest');
  });

  it('returns empty for no matches', async () => {
    semanticStore.entries = [
      makeEntry({ text: 'completely unrelated', type: 'semantic' }),
    ];
    const results = await retriever.search('vitest typescript');
    expect(results).toHaveLength(0);
  });

  it('respects limit parameter', async () => {
    semanticStore.entries = Array(20).fill(null).map((_, i) =>
      makeEntry({ id: `${i}`, text: `typescript fact number ${i}`, type: 'semantic' }),
    );
    const results = await retriever.search('typescript', { limit: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it('searches across semantic + episodic stores', async () => {
    semanticStore.entries = [makeEntry({ id: '1', text: 'prefers dark mode', type: 'semantic' })];
    episodicStore.entries = [makeEntry({ id: '2', text: 'switched to dark mode today', type: 'episodic' })];
    const results = await retriever.search('dark mode');
    expect(results).toHaveLength(2);
  });

  it('deduplicates entries with same id', async () => {
    semanticStore.entries = [makeEntry({ id: 'dup', text: 'same entry in both', type: 'semantic' })];
    episodicStore.entries = [makeEntry({ id: 'dup', text: 'same entry in both', type: 'episodic' })];
    const results = await retriever.search('same entry');
    expect(results).toHaveLength(1);
  });
});
