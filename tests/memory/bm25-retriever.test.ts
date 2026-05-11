import { describe, it, expect, vi, beforeEach } from 'bun:test';
import type { MemoryEntry, MemoryStore } from '../../src/memory/types';
import { BM25Retriever } from '../../src/memory/bm25-retriever';

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return { id: overrides.id ?? 'test-id', type: 'general', text: 'test',
    weight: 1, source: 'explicit', created: new Date().toISOString(), ...overrides };
}

class Fts5MockStore implements Partial<MemoryStore> {
  entries: MemoryEntry[] = [];
  getAll = vi.fn().mockImplementation(() => Promise.resolve(this.entries));
  ftsSearch = vi.fn().mockImplementation(
    async (_query: string, _type: string, limit: number) => {
      const tokens = _query.toLowerCase().split(/\s+/);
      return this.entries
        .filter(e => tokens.some(t => e.text.toLowerCase().includes(t)))
        .slice(0, limit);
    },
  );
}

describe('BM25Retriever', () => {
  let store: Fts5MockStore;
  let retriever: BM25Retriever;

  beforeEach(() => {
    store = new Fts5MockStore();
    retriever = new BM25Retriever(store as any);
  });

  it('ranks exact term match highest', async () => {
    store.entries = [
      makeEntry({ id: '1', text: 'user prefers vitest over jest' }),
      makeEntry({ id: '2', text: 'project uses react for UI' }),
    ];
    const results = await retriever.search('vitest');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain('vitest');
  });

  it('returns empty for no matches', async () => {
    store.entries = [makeEntry({ text: 'unrelated' })];
    const results = await retriever.search('nonexistent');
    expect(results).toHaveLength(0);
  });

  it('respects limit parameter', async () => {
    store.entries = Array(20).fill(null).map((_, i) => makeEntry({ id: `${i}`, text: `typescript ${i}` }));
    const results = await retriever.search('typescript', { limit: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
  });
});
