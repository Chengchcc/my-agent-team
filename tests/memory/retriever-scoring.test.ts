import { describe, it, expect } from 'bun:test';
import { KeywordRetriever } from '../../src/memory/retriever';
import type { MemoryEntry, MemoryStore } from '../../src/memory/types';

function makeStore(entries: MemoryEntry[]): MemoryStore {
  return {
    getAll: async () => entries,
    getByType: async () => entries,
    add: async (e) => { entries.push({ ...e, id: 'x', created: new Date().toISOString() } as MemoryEntry); return entries[entries.length - 1]!; },
    get: async () => null,
    update: async () => null,
    remove: async () => false,
    replaceAll: async () => {},
    count: async () => entries.length,
    getRecent: async (n) => entries.slice(0, n),
  };
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'test-1',
    type: 'semantic',
    text: 'User prefers React for frontend development',
    tags: ['react', 'frontend'],
    created: new Date().toISOString(),
    weight: 0.5,
    source: 'user',
    ...overrides,
  };
}

describe('KeywordRetriever scoring enhancement', () => {
  it('should rank frequently used entries higher than unused ones with same text match', async () => {
    const SAME_CREATED = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const highUsage = makeEntry({
      id: 'high-usage',
      text: 'User prefers React',
      tags: ['react'],
      created: SAME_CREATED,
      usageCount: 10,
      lastHitAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
    });
    const noUsage = makeEntry({
      id: 'no-usage',
      text: 'User prefers React',
      tags: ['react'],
      created: SAME_CREATED,
      usageCount: undefined,
      lastHitAt: undefined,
    });

    const store = makeStore([highUsage, noUsage]);
    const retriever = new KeywordRetriever(store, makeStore([]), makeStore([]));

    const results = await retriever.search('React');
    expect(results.length).toBeGreaterThanOrEqual(2);
    // High usage entry should rank first
    expect(results[0]!.id).toBe('high-usage');
  });

  it('should prefer entries with recent lastHitAt over older ones', async () => {
    const OLD_CREATED = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000).toISOString();
    const recentHit = makeEntry({
      id: 'recent-hit',
      text: 'Use TypeScript strict mode',
      tags: ['typescript'],
      created: OLD_CREATED,
      usageCount: 1,
      lastHitAt: Date.now(),
    });
    const oldHit = makeEntry({
      id: 'old-hit',
      text: 'Use TypeScript strict mode',
      tags: ['typescript'],
      created: OLD_CREATED,
      usageCount: 1,
      lastHitAt: Date.now() - 365 * 24 * 60 * 60 * 1000,
    });

    const store = makeStore([oldHit, recentHit]);
    const retriever = new KeywordRetriever(store, makeStore([]), makeStore([]));

    const results = await retriever.search('TypeScript');
    expect(results.length).toBeGreaterThanOrEqual(2);
    // Recently hit entry should rank higher
    expect(results[0]!.id).toBe('recent-hit');
  });

  it('should handle missing usageCount and lastHitAt gracefully', async () => {
    const entry = makeEntry({
      id: 'minimal',
      text: 'Use pnpm as package manager',
      tags: ['pnpm'],
      usageCount: undefined,
      lastHitAt: undefined,
    });

    const store = makeStore([entry]);
    const retriever = new KeywordRetriever(store, makeStore([]), makeStore([]));

    const results = await retriever.search('pnpm');
    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe('minimal');
  });
});
