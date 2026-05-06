import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { TraceBuffer } from '../../src/trace/trace-buffer';
import { TraceStore } from '../../src/trace/store';

const TEST_DIR = path.join(os.tmpdir(), `trace-buffer-test-${Date.now()}`);

describe('TraceBuffer', () => {
  let store: TraceStore;

  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
    store = new TraceStore(TEST_DIR);
  });

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  test('creates buffer with runId, sessionId, and startTime', () => {
    const buffer = new TraceBuffer('session-1', store);
    expect(buffer.runId).toBeString();
    expect(buffer.runId.length).toBeGreaterThan(0);
    expect(buffer.sessionId).toBe('session-1');
  });

  test('recordModelResponse creates a new turn and appends NDJSON line', async () => {
    const buffer = new TraceBuffer('session-1', store);
    buffer.recordModelResponse({
      text: 'Hello world',
      toolCalls: [{ name: 'read', arguments: { file: 'test.ts' } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    const trace = buffer.finalize('test-model');
    expect(trace.turns.length).toBe(1);
    expect(trace.turns[0]!.modelResponse!.text).toBe('Hello world');
    expect(trace.turns[0]!.modelResponse!.toolCalls.length).toBe(1);
  });

  test('recordToolExecution appends to current turn and writes NDJSON', async () => {
    const buffer = new TraceBuffer('session-1', store);
    buffer.recordModelResponse({
      text: 'Running tool', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    buffer.recordToolExecution({ toolName: 'bash', success: true, durationMs: 42 });
    buffer.recordToolExecution({ toolName: 'read', success: false, durationMs: 100, error: 'ENOENT' });

    const trace = buffer.finalize('test-model');
    expect(trace.turns[0]!.toolExecutions.length).toBe(2);
    expect(trace.turns[0]!.toolExecutions[1]!.error).toBe('ENOENT');
  });

  test('second recordModelResponse advances to a new turn', () => {
    const buffer = new TraceBuffer('session-1', store);
    buffer.recordModelResponse({
      text: 'Turn 0', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    buffer.recordModelResponse({
      text: 'Turn 1', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const trace = buffer.finalize('test-model');
    expect(trace.turns.length).toBe(2);
    expect(trace.turns[0]!.turnIndex).toBe(0);
    expect(trace.turns[1]!.turnIndex).toBe(1);
  });

  test('finalize returns complete TraceRun with summary', async () => {
    const buffer = new TraceBuffer('session-1', store);
    buffer.recordModelResponse({
      text: 'Done', toolCalls: [], usage: { prompt_tokens: 50, completion_tokens: 10 },
    });
    buffer.recordToolExecution({ toolName: 'read', success: true, durationMs: 10 });

    const trace = buffer.finalize('test-model');
    expect(trace.id).toBe(buffer.runId);
    expect(trace.sessionId).toBe('session-1');
    expect(trace.model).toBe('test-model');
    expect(trace.summary.totalTurns).toBe(1);
    expect(trace.summary.totalToolCalls).toBe(1);
    expect(trace.summary.totalErrors).toBe(0);
    expect(trace.summary.outcome).toBe('completed');
  });

  test('summary correctly counts errors', () => {
    const buffer = new TraceBuffer('session-1', store);
    buffer.recordModelResponse({
      text: 'Trying', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    buffer.recordToolExecution({ toolName: 'bash', success: false, durationMs: 50, error: 'cmd failed' });

    buffer.recordModelResponse({
      text: 'Retry', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    buffer.recordToolExecution({ toolName: 'bash', success: true, durationMs: 30 });

    const trace = buffer.finalize('test-model');
    expect(trace.summary.totalErrors).toBe(1);
  });

  test('parentRunId is preserved', () => {
    const buffer = new TraceBuffer('session-1', store, 'parent-run-99');
    const trace = buffer.finalize('test-model');
    expect(trace.parentRunId).toBe('parent-run-99');
  });

  test('finalize without any turns produces empty trace', () => {
    const buffer = new TraceBuffer('session-1', store);
    const trace = buffer.finalize('test-model');
    expect(trace.turns.length).toBe(0);
    expect(trace.summary.totalTurns).toBe(0);
    expect(trace.summary.outcome).toBe('completed');
  });

  test('recordUserMessage is persisted in the first turn', async () => {
    const buffer = new TraceBuffer('session-1', store);
    buffer.recordUserMessage('Hello, please help me');
    buffer.recordModelResponse({
      text: 'Sure!', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    await buffer.flush();
    const trace = buffer.finalize('test-model');
    expect(trace.turns[0]!.userMessage).toBe('Hello, please help me');
  });

  test('recordUserMessage does not affect subsequent turns', () => {
    const buffer = new TraceBuffer('session-1', store);
    buffer.recordUserMessage('Message 1');
    buffer.recordModelResponse({
      text: 'Response 1', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    buffer.recordModelResponse({
      text: 'Response 2', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const trace = buffer.finalize('test-model');
    expect(trace.turns[0]!.userMessage).toBe('Message 1');
    expect(trace.turns[1]!.userMessage).toBeUndefined();
  });
});
