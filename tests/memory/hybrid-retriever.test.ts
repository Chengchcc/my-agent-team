import { describe, it, expect, vi, beforeEach } from 'bun:test';
import type { MemoryEntry } from '../../src/memory/types';
import { HybridRetriever } from '../../src/memory/hybrid-retriever';

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

function mockRetriever(results: MemoryEntry[]) {
  return { search: vi.fn().mockResolvedValue(results) };
}

describe('HybridRetriever', () => {
  let keywordRet: ReturnType<typeof mockRetriever>;
  let bm25Ret: ReturnType<typeof mockRetriever>;
  let vectorRet: ReturnType<typeof mockRetriever>;
  let hybrid: HybridRetriever;

  beforeEach(() => {
    keywordRet = mockRetriever([]);
    bm25Ret = mockRetriever([]);
    vectorRet = mockRetriever([]);
    hybrid = new HybridRetriever(keywordRet as any, bm25Ret as any, vectorRet as any);
  });

  it('fuses results from all three retrievers', async () => {
    keywordRet.search.mockResolvedValue([makeEntry({ id: 'a', text: 'keyword match' })]);
    bm25Ret.search.mockResolvedValue([makeEntry({ id: 'b', text: 'bm25 match' })]);
    vectorRet.search.mockResolvedValue([makeEntry({ id: 'c', text: 'vector match' })]);

    const results = await hybrid.search('test');
    expect(results).toHaveLength(3);
  });

  it('entry appearing in all three retrievers ranks first', async () => {
    const shared = makeEntry({ id: 'shared', text: 'shared match' });
    keywordRet.search.mockResolvedValue([shared]);
    bm25Ret.search.mockResolvedValue([shared]);
    // shared in two lists (rank 1 each) + vector has only "other" (rank 1)
    // shared: 0.5/62 + 0.3/61 + 0.2/61 = higher than other: 0.5/61
    vectorRet.search.mockResolvedValue([
      makeEntry({ id: 'other', text: 'vector only' }),
      shared,
    ]);

    const results = await hybrid.search('test');
    expect(results[0].id).toBe('shared');
  });

  it('deduplicates by entry id', async () => {
    const dup = makeEntry({ id: 'dup', text: 'same entry' });
    keywordRet.search.mockResolvedValue([dup]);
    bm25Ret.search.mockResolvedValue([dup]);
    vectorRet.search.mockResolvedValue([dup]);

    const results = await hybrid.search('test');
    expect(results).toHaveLength(1);
  });

  it('falls back when vector retriever fails', async () => {
    keywordRet.search.mockResolvedValue([makeEntry({ id: 'k1', text: 'keyword result' })]);
    bm25Ret.search.mockResolvedValue([makeEntry({ id: 'b1', text: 'bm25 result' })]);
    vectorRet.search.mockRejectedValue(new Error('model not loaded'));

    const results = await hybrid.search('test');
    expect(results.length).toBeGreaterThanOrEqual(1);
    const ids = results.map(r => r.id);
    expect(ids).toContain('k1');
    expect(ids).toContain('b1');
  });

  it('respects limit parameter', async () => {
    keywordRet.search.mockResolvedValue(
      Array(10).fill(null).map((_, i) => makeEntry({ id: `k${i}`, text: `keyword ${i}` })),
    );
    bm25Ret.search.mockResolvedValue(
      Array(10).fill(null).map((_, i) => makeEntry({ id: `b${i}`, text: `bm25 ${i}` })),
    );
    vectorRet.search.mockResolvedValue(
      Array(10).fill(null).map((_, i) => makeEntry({ id: `v${i}`, text: `vector ${i}` })),
    );

    const results = await hybrid.search('test', { limit: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it('returns empty when all retrievers return empty', async () => {
    const results = await hybrid.search('nonexistent');
    expect(results).toHaveLength(0);
  });
});
