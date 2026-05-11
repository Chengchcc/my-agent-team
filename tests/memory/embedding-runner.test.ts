import { describe, it, expect, vi } from 'bun:test';
import { EmbeddingTaskRunner } from '../../src/memory/embedding-runner';

describe('EmbeddingTaskRunner', () => {
  it('encodes text and updates store', async () => {
    const mockEncode = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
    const mockUpdate = vi.fn().mockResolvedValue({ id: 'e1', text: 'test' });
    const mockStore = { update: mockUpdate };

    const runner = new EmbeddingTaskRunner(mockEncode, mockStore as any, mockStore as any, mockStore as any);
    const result = await runner.run({
      entryId: 'e1',
      text: 'test text',
      storeType: 'semantic',
    });

    expect(mockEncode).toHaveBeenCalledWith('test text');
    expect(mockUpdate).toHaveBeenCalledWith('e1', { embedding: [0.1, 0.2, 0.3] });
    expect(result.outcome).toBe('completed');
  });

  it('returns failed outcome on encode error', async () => {
    const mockEncode = vi.fn().mockRejectedValue(new Error('model crashed'));
    const mockStore = { update: vi.fn() };
    const runner = new EmbeddingTaskRunner(mockEncode, mockStore as any, mockStore as any, mockStore as any);
    const result = await runner.run({
      entryId: 'e1', text: 'text', storeType: 'semantic',
    });
    expect(result.outcome).toBe('failed');
  });

  it('routes to correct store by type', async () => {
    const mockEncode = vi.fn().mockResolvedValue([0.5]);
    const semUpdate = vi.fn().mockResolvedValue({});
    const epiUpdate = vi.fn().mockResolvedValue({});
    const projUpdate = vi.fn().mockResolvedValue({});

    const runner = new EmbeddingTaskRunner(
      mockEncode,
      { update: semUpdate } as any,
      { update: epiUpdate } as any,
      { update: projUpdate } as any,
    );

    await runner.run({ entryId: 'e1', text: 'sem', storeType: 'semantic' });
    expect(semUpdate).toHaveBeenCalled();

    await runner.run({ entryId: 'e2', text: 'epi', storeType: 'episodic' });
    expect(epiUpdate).toHaveBeenCalled();

    await runner.run({ entryId: 'e3', text: 'proj', storeType: 'project' });
    expect(projUpdate).toHaveBeenCalled();
  });
});
