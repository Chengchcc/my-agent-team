import { describe, test, expect } from 'bun:test';
import { TraceToolMiddleware } from '../../src/trace/tool-middleware';
import { TraceBuffer } from '../../src/trace/trace-buffer';
import type { AgentContext } from '../../src/types';
import type { ToolContext } from '../../src/agent/tool-dispatch/types';
import { TraceStore } from '../../src/trace/store';
import os from 'os';
import path from 'path';

function makeCtx(overrides: Partial<{ buffer: TraceBuffer | undefined }> = {}): ToolContext {
  const metadata: Record<string, unknown> = {};
  if (overrides.buffer !== undefined) {
    metadata._traceBuffer = overrides.buffer;
  }
  return {
    signal: new AbortController().signal,
    agentContext: { messages: [], config: { tokenLimit: 1000 }, metadata } as AgentContext,
    budget: { remaining: 1000, usageRatio: 0 },
    environment: { agentType: 'main', cwd: '/test' },
    metadata: new Map(),
    sink: { updateTodos: () => {}, _todoUpdates: undefined },
  };
}

describe('TraceToolMiddleware', () => {
  test('records successful tool execution', async () => {
    const store = new TraceStore(path.join(os.tmpdir(), `ttm-test-${Date.now()}`));
    const buffer = new TraceBuffer('s1', store);
    buffer.recordModelResponse({ text: '', toolCalls: [], usage: {} });

    const middleware = new TraceToolMiddleware();
    const toolCall = { id: '1', name: 'bash', arguments: {} };
    const ctx = makeCtx({ buffer });

    await middleware.handle(toolCall, ctx, async () => 'result');

    const trace = buffer.finalize('test');
    expect(trace.turns[0]!.toolExecutions.length).toBe(1);
    expect(trace.turns[0]!.toolExecutions[0]!.success).toBe(true);
    expect(trace.turns[0]!.toolExecutions[0]!.toolName).toBe('bash');
    expect(trace.turns[0]!.toolExecutions[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  test('records failed tool execution with error message', async () => {
    const store = new TraceStore(path.join(os.tmpdir(), `ttm-test-${Date.now()}`));
    const buffer = new TraceBuffer('s2', store);
    buffer.recordModelResponse({ text: '', toolCalls: [], usage: {} });

    const middleware = new TraceToolMiddleware();
    const toolCall = { id: '2', name: 'grep', arguments: {} };
    const ctx = makeCtx({ buffer });

    try {
      await middleware.handle(toolCall, ctx, async () => { throw new Error('no matches'); });
    } catch { /* expected */ }

    const trace = buffer.finalize('test');
    expect(trace.turns[0]!.toolExecutions[0]!.success).toBe(false);
    expect(trace.turns[0]!.toolExecutions[0]!.error).toBe('no matches');
  });

  test('re-throws the original error after recording', async () => {
    const store = new TraceStore(path.join(os.tmpdir(), `ttm-test-${Date.now()}`));
    const buffer = new TraceBuffer('s3', store);
    buffer.recordModelResponse({ text: '', toolCalls: [], usage: {} });

    const middleware = new TraceToolMiddleware();
    const ctx = makeCtx({ buffer });
    const err = new Error('original');

    let caught: Error | undefined;
    try {
      await middleware.handle({ id: '3', name: 'bash', arguments: {} }, ctx, async () => { throw err; });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBe(err);
  });

  test('no-op when no trace buffer in context', async () => {
    const middleware = new TraceToolMiddleware();
    const ctx = makeCtx({ buffer: undefined });

    const result = await middleware.handle(
      { id: '4', name: 'read', arguments: {} },
      ctx,
      async () => 'ok',
    );
    expect(result).toBe('ok');
  });

  test('middleware name is "trace"', () => {
    const mw = new TraceToolMiddleware();
    expect(mw.name).toBe('trace');
  });
});
