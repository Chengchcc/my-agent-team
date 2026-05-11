import { describe, it, expect, vi } from 'bun:test';
import { EmbeddingTaskRunner } from '../../src/memory/embedding-runner';

describe('EmbeddingTaskRunner', () => {
  it('encodes text and stores via storeEmbedding', async () => {
    const mockEncode = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    const mockStoreEmbedding = vi.fn().mockResolvedValue(undefined);
    const mockStore = { storeEmbedding: mockStoreEmbedding };

    const runner = new EmbeddingTaskRunner(mockEncode, mockStore as any);
    const result = await runner.run({ entryId: 'e1', text: 'test text' });
    expect(mockEncode).toHaveBeenCalledWith('test text');
    expect(mockStoreEmbedding).toHaveBeenCalledWith('e1', [0.1, 0.2, 0.3]);
    expect(result.outcome).toBe('completed');
  });

  it('falls back to store.update when storeEmbedding is absent', async () => {
    const mockEncode = vi.fn().mockResolvedValue([0.4, 0.5]);
    const mockUpdate = vi.fn().mockResolvedValue({ id: 'e1', text: 'test' });
    const mockStore = { update: mockUpdate };

    const runner = new EmbeddingTaskRunner(mockEncode, mockStore as any);
    const result = await runner.run({ entryId: 'e1', text: 'text' });
    expect(mockUpdate).toHaveBeenCalledWith('e1', { embedding: [0.4, 0.5] });
    expect(result.outcome).toBe('completed');
  });

  it('returns failed outcome on encode error', async () => {
    const mockEncode = vi.fn().mockRejectedValue(new Error('crashed'));
    const runner = new EmbeddingTaskRunner(mockEncode, {} as any);
    const result = await runner.run({ entryId: 'e1', text: 'text' });
    expect(result.outcome).toBe('failed');
  });
});
