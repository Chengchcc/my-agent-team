import { describe, test, expect } from 'bun:test';
import { ContextManager } from '../../src/agent/context';

describe('ContextManager initialMetadata', () => {
  test('initialMetadata is merged into getContext metadata', () => {
    const cm = new ContextManager({
      tokenLimit: 10000,
      initialMetadata: { _parentTraceRunId: 'parent-123', custom: 'value' },
    });

    const ctx = cm.getContext({ tokenLimit: 10000 });
    expect(ctx.metadata._parentTraceRunId).toBe('parent-123');
    expect(ctx.metadata.custom).toBe('value');
  });

  test('getContext todo metadata still works with initialMetadata', () => {
    const cm = new ContextManager({
      tokenLimit: 10000,
      initialMetadata: { _parentTraceRunId: 'parent-456' },
    });

    const ctx = cm.getContext({ tokenLimit: 10000 });
    expect(ctx.metadata.todo).toBeDefined();
    expect(ctx.metadata._parentTraceRunId).toBe('parent-456');
  });

  test('no initialMetadata defaults to empty', () => {
    const cm = new ContextManager({ tokenLimit: 10000 });
    const ctx = cm.getContext({ tokenLimit: 10000 });
    expect(ctx.metadata.todo).toBeDefined();
    expect(ctx.metadata._parentTraceRunId).toBeUndefined();
  });
});
