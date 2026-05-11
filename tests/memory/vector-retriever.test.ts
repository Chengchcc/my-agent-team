import { describe, it, expect, vi, beforeEach } from 'bun:test';
import type { MemoryEntry, MemoryStore } from '../../src/memory/types';
import { VectorRetriever } from '../../src/memory/vector-retriever';

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: overrides.id ?? 'test-id',
    type: 'general',
    text: 'test',
    weight: 1,
    source: 'explicit',
    created: new Date().toISOString(),
    ...overrides,
  };
}

class MockStore implements Partial<MemoryStore> {
  entries: MemoryEntry[] = [];
  getAll = vi.fn().mockImplementation(() => Promise.resolve(this.entries));
  update = vi.fn().mockResolvedValue(null);
}

describe('VectorRetriever', () => {
  let sem: MockStore;
  let epi: MockStore;
  let proj: MockStore;
  let retriever: VectorRetriever;

  beforeEach(() => {
    sem = new MockStore();
    epi = new MockStore();
    proj = new MockStore();
    retriever = new VectorRetriever(sem as any, {
      ollamaModel: 'test-model',
      ollamaBaseUrl: 'http://localhost:9999',
    });
  });

  it('cosine similarity: identical vectors = 1', () => {
    const v = [0.5, 0.3, 0.1];
    expect((retriever as any).cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('cosine similarity: orthogonal vectors = 0', () => {
    expect((retriever as any).cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
  });

  it('cosine similarity: opposite vectors = -1', () => {
    expect((retriever as any).cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1, 5);
  });

  it('ranks entries by embedding similarity', async () => {
    sem.entries = [
      makeEntry({ id: '1', text: 'relevant', embedding: [0.9, 0.1, 0] }),
      makeEntry({ id: '2', text: 'irrelevant', embedding: [0, 1, 0] }),
    ];
    (retriever as any).encode = vi.fn().mockResolvedValue([1, 0, 0]);

    const results = await retriever.search('test query');
    expect(results[0].id).toBe('1');
  });

  it('skips entries without embeddings', async () => {
    sem.entries = [makeEntry({ id: '1', text: 'no embedding' })];
    (retriever as any).encode = vi.fn().mockResolvedValue([1, 0, 0]);

    const results = await retriever.search('test');
    expect(results).toHaveLength(0);
  });

  it('returns empty when encode fails (Ollama unreachable)', async () => {
    sem.entries = [makeEntry({ id: '1', text: 'fact', embedding: [0.1, 0.2] })];
    (retriever as any).encode = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const results = await retriever.search('test');
    expect(results).toHaveLength(0);
  });
});
