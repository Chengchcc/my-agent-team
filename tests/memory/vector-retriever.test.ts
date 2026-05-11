import { describe, it, expect, vi, beforeEach } from 'bun:test';
import type { MemoryEntry } from '../../src/memory/types';
import { VectorRetriever } from '../../src/memory/vector-retriever';

function makeEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return { id: overrides.id ?? 'test-id', type: 'general', text: 'test',
    weight: 1, source: 'explicit', created: new Date().toISOString(), ...overrides };
}

describe('VectorRetriever', () => {
  let retriever: VectorRetriever;
  let mockVectorSearch: ReturnType<typeof vi.fn>;
  let mockGet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockVectorSearch = vi.fn().mockResolvedValue([]);
    mockGet = vi.fn().mockResolvedValue(null);
    retriever = new VectorRetriever({
      vectorSearch: mockVectorSearch,
      get: mockGet,
    } as any, {
      ollamaModel: 'test-model',
      ollamaBaseUrl: 'http://localhost:9999',
    });
  });

  it('searches via store.vectorSearch with encoded query', async () => {
    const mockEncode = vi.fn().mockResolvedValue([1, 0, 0]);
    (retriever as any).encode = mockEncode;

    mockVectorSearch.mockResolvedValue([{ entryId: 'e1', distance: 0.1 }]);
    mockGet.mockResolvedValue(makeEntry({ id: 'e1', text: 'relevant result' }));

    const results = await retriever.search('test query');
    expect(mockEncode).toHaveBeenCalledWith('test query');
    expect(mockVectorSearch).toHaveBeenCalledWith([1, 0, 0], 10);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('e1');
  });

  it('returns empty when encode fails', async () => {
    (retriever as any).encode = vi.fn().mockRejectedValue(new Error('Ollama down'));
    const results = await retriever.search('test');
    expect(results).toHaveLength(0);
  });

  it('returns empty when store has no vectorSearch', async () => {
    const plainRetriever = new VectorRetriever({} as any);
    (plainRetriever as any).encode = vi.fn().mockResolvedValue([1, 0, 0]);
    const results = await plainRetriever.search('test');
    expect(results).toHaveLength(0);
  });

  it('respects limit and skips entries not found', async () => {
    (retriever as any).encode = vi.fn().mockResolvedValue([1, 0, 0]);
    mockVectorSearch.mockResolvedValue([
      { entryId: 'e1', distance: 0.1 },
      { entryId: 'e2', distance: 0.2 },
    ]);
    mockGet.mockImplementation((id: string) =>
      id === 'e1' ? makeEntry({ id: 'e1', text: 'found' }) : null,
    );

    const results = await retriever.search('test', { limit: 2 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('e1');
  });
});
