import { describe, it, expect, vi, beforeEach } from 'bun:test';
import type { MemoryEntry, MemoryStore } from '../../src/memory/types';
import { KeywordRetriever } from '../../src/memory/retriever';

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: 'test-id', type: 'general', text: 'test',
    weight: 1, source: 'explicit', created: new Date().toISOString(),
    ...overrides,
  };
}

class MockMemoryStore implements Partial<MemoryStore> {
  entries: MemoryEntry[] = [];
  getAll = vi.fn().mockImplementation(() => Promise.resolve(this.entries));
}

describe('KeywordRetriever', () => {
  let store: MockMemoryStore;
  let retriever: KeywordRetriever;

  beforeEach(() => {
    store = new MockMemoryStore();
    retriever = new KeywordRetriever(store as any);
  });

  it('exact keyword match gets high score', async () => {
    store.entries = [
      makeEntry({ text: 'user prefers vitest over jest' }),
      makeEntry({ text: 'project uses react' }),
    ];
    const results = await retriever.search('vitest');
    expect(results[0].text).toContain('vitest');
  });

  it('tag match increases score', async () => {
    store.entries = [
      makeEntry({ text: 'some fact', tags: ['typescript', 'testing'] }),
      makeEntry({ text: 'typescript is used' }),
    ];
    const results = await retriever.search('testing');
    expect(results[0].tags).toContain('testing');
  });

  it('more recent memories get higher score', async () => {
    store.entries = [
      makeEntry({ text: 'prefers pnpm', created: '2020-01-01T00:00:00Z' }),
      makeEntry({ text: 'prefers pnpm (confirmed)', created: new Date().toISOString() }),
    ];
    const results = await retriever.search('pnpm');
    expect(new Date(results[0].created).getTime()).toBeGreaterThan(new Date(results[1].created).getTime());
  });

  it('higher weight gets higher score', async () => {
    store.entries = [
      makeEntry({ text: 'uses bun', weight: 0.3 }),
      makeEntry({ text: 'uses bun runtime', weight: 1.0 }),
    ];
    const results = await retriever.search('bun');
    expect(results[0].weight).toBe(1.0);
  });

  it('no matches → empty array', async () => {
    store.entries = [makeEntry({ text: 'unrelated' })];
    const results = await retriever.search('nonexistent');
    expect(results).toHaveLength(0);
  });

  it('limit parameter restricts results', async () => {
    store.entries = Array(20).fill(null).map((_, i) => makeEntry({ text: `typescript ${i}` }));
    const results = await retriever.search('typescript', { limit: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
  });
});

describe('Tokenizer', () => {
  let retriever: KeywordRetriever;

  beforeEach(() => {
    retriever = new KeywordRetriever({ getAll: async () => [] } as any);
  });

  it('splits Chinese into individual characters', async () => {
    const store = { getAll: vi.fn().mockResolvedValue([makeEntry({ text: '用户偏好暗色主题' })]) };
    const r = new KeywordRetriever(store as any);
    const results = await r.search('暗色主题');
    expect(results).toHaveLength(1);
  });

  it('English matches whole words, filters out single letters', () => {
    const tokens = (retriever as any).tokenize('a b');
    expect(tokens).toHaveLength(0);
  });

  it('handles mixed Chinese and English', async () => {
    const store = { getAll: vi.fn().mockResolvedValue([makeEntry({ text: '项目使用 vitest 做测试' })]) };
    const r = new KeywordRetriever(store as any);
    const results = await r.search('vitest 测试');
    expect(results).toHaveLength(1);
  });
});
