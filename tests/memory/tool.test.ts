import { describe, it, expect, vi, beforeEach } from 'bun:test';
import type { MemoryEntry, MemoryStore, MemoryRetriever } from '../../src/memory/types';
import { MemoryTool } from '../../src/memory/tool';

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return { id: 'test-id', type: 'general', text: 'test',
    weight: 1, source: 'explicit', created: new Date().toISOString(), ...overrides };
}

class MockStore implements Partial<MemoryStore> {
  entries: MemoryEntry[] = [];
  add = vi.fn().mockImplementation((e: any) => Promise.resolve({ ...e, id: 'new-id', created: new Date().toISOString(), type: 'general' }));
  getAll = vi.fn().mockImplementation(() => Promise.resolve([...this.entries]));
  getRecent = vi.fn().mockImplementation((limit: number) => Promise.resolve(this.entries.slice(0, limit)));
  remove = vi.fn().mockResolvedValue(true);
}

class MockRetriever implements Partial<MemoryRetriever> {
  search = vi.fn().mockResolvedValue([]);
}

describe('MemoryTool', () => {
  let tool: MemoryTool;
  let store: MockStore;
  let retriever: MockRetriever;

  beforeEach(() => {
    store = new MockStore();
    retriever = new MockRetriever();
    tool = new MemoryTool(store as any, retriever as any);
  });

  it('search returns results', async () => {
    retriever.search.mockResolvedValue([makeEntry({ text: 'prefers pnpm' })]);
    const result = await (tool as any).handle({ command: 'search', query: 'pnpm', limit: 5 });
    expect(result.results).toHaveLength(1);
  });

  it('add stores with source=user', async () => {
    const result = await (tool as any).handle({ command: 'add', text: 'user likes dark mode' });
    expect(result.entry.text).toBe('user likes dark mode');
    const call = store.add.mock.calls[0]?.[0] ?? {};
    expect(call.source).toBe('user');
  });

  it('list returns recent entries', async () => {
    store.entries = [makeEntry({ text: 'a' }), makeEntry({ text: 'b' })];
    const result = await (tool as any).handle({ command: 'list', limit: 2 });
    expect(result.results).toHaveLength(2);
  });

  it('forget removes by id', async () => {
    const result = await (tool as any).handle({ command: 'forget', id: 'test-id' });
    expect(result.removed).toBe(true);
  });
});
