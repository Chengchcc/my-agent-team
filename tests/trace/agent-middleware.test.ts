import { describe, test, expect, beforeEach, afterEach, vi } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { TraceAgentMiddleware } from '../../src/trace/agent-middleware';
import { TraceStore } from '../../src/trace/store';
import { NudgeEngine } from '../../src/trace/nudge-engine';
import { DefaultRedactor } from '../../src/trace/redactor';
import { TraceBuffer } from '../../src/trace/trace-buffer';
import type { AgentContext, AgentConfig, LLMResponse } from '../../src/types';

const TEST_DIR = path.join(os.tmpdir(), `tam-test-${Date.now()}`);

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  const config: AgentConfig = { tokenLimit: 10000 };
  return {
    messages: [
      { role: 'user', content: 'hello world', id: 'msg-1' },
    ],
    config,
    metadata: { sessionId: 'test-session' },
    ...overrides,
  };
}

describe('TraceAgentMiddleware', () => {
  let store: TraceStore;
  let nudgeEngine: NudgeEngine;
  let redactor: DefaultRedactor;
  let middleware: TraceAgentMiddleware;
  let statePath: string;

  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
    statePath = path.join(TEST_DIR, 'nudge-state.json');
    store = new TraceStore(TEST_DIR);
    nudgeEngine = new NudgeEngine(statePath);
    redactor = new DefaultRedactor('default');
    middleware = new TraceAgentMiddleware(store, nudgeEngine, redactor);
  });

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  test('beforeAgentRun creates TraceBuffer and records user message', async () => {
    const ctx = makeContext();
    const next = vi.fn(async () => ctx);

    const result = await middleware.beforeAgentRun!(ctx, next);
    expect(next).toHaveBeenCalled();
    const buffer = result.metadata._traceBuffer as TraceBuffer;
    expect(buffer).toBeDefined();
    expect(buffer.runId).toBeString();
  });

  test('beforeAddResponse records model response with redacted text', async () => {
    const ctx = makeContext();
    const nextCtx = await middleware.beforeAgentRun!(ctx, vi.fn(async () => ctx));

    const response: LLMResponse = {
      content: 'API key is sk-abc123def456ghi789jkl012345',
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      model: 'test-model',
      tool_calls: [{ id: 'tc1', name: 'read', arguments: { file: '/secret/config.yml' } }],
    };

    const ctxWithResponse = { ...nextCtx, response };
    const next = vi.fn(async () => ctxWithResponse);

    const result = await middleware.beforeAddResponse!(ctxWithResponse, next);
    expect(next).toHaveBeenCalled();
    const buffer = result.metadata._traceBuffer as TraceBuffer;
    const trace = buffer.finalize('test-model');
    expect(trace.turns.length).toBe(1);
    expect(trace.turns[0]!.modelResponse!.text).not.toContain('sk-abc123def456ghi789jkl012345');
    // Note: thinking is undefined -- response.blocks are set AFTER beforeAddResponse
    expect(trace.turns[0]!.modelResponse!.thinking).toBeUndefined();
  });

  test('afterAgentRun finalizes trace and calls nudgeEngine.tick', async () => {
    const ctx = makeContext();
    const ctxWithBuffer = await middleware.beforeAgentRun!(ctx, vi.fn(async () => ctx));
    const buffer = ctxWithBuffer.metadata._traceBuffer as TraceBuffer;
    buffer.recordModelResponse({ text: 'done', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });

    const next = vi.fn(async () => ctxWithBuffer);
    const tickSpy = vi.spyOn(nudgeEngine, 'tick');

    const result = await middleware.afterAgentRun!(ctxWithBuffer, next);
    expect(next).toHaveBeenCalled();

    // Wait for setImmediate
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(tickSpy).toHaveBeenCalled();
    tickSpy.mockRestore();
  });

  test('no-op when no TraceBuffer in context', async () => {
    const ctx = makeContext();
    const next = vi.fn(async () => ctx);

    const result = await middleware.beforeAddResponse!(ctx, next);
    expect(result).toBe(ctx);

    const result2 = await middleware.afterAgentRun!(ctx, next);
    expect(result2).toBe(ctx);
  });
});
