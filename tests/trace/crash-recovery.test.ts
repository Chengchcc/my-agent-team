import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { TraceStore } from '../../src/trace/store';
import { TraceBuffer } from '../../src/trace/trace-buffer';

const TEST_DIR = path.join(os.tmpdir(), `crash-test-${Date.now()}`);

describe('Crash recovery', () => {
  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  test('partial NDJSON file (missing summary) is recoverable', async () => {
    const store = new TraceStore(TEST_DIR);
    const buffer = new TraceBuffer('session-1', store);
    buffer.recordModelResponse({
      text: 'turn 0',
      toolCalls: [{ name: 'read', arguments: {} }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    buffer.recordToolExecution({ toolName: 'read', success: true, durationMs: 10 });

    buffer.recordModelResponse({
      text: 'turn 1',
      toolCalls: [{ name: 'bash', arguments: {} }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    });

    // Wait for sequential writes to land on disk
    await buffer.flush();

    // Simulate crash: don't call finalize. Verify NDJSON file exists
    // and contains turn/tool lines without summary.
    const filePath = path.join(TEST_DIR, 'session-1', `${buffer.runId}.jsonl`);
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');

    // Should have: turn0, tool_read, turn1 (no summary)
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[0]!).type).toBe('turn');
    expect(JSON.parse(lines[1]!).type).toBe('tool');
    expect(JSON.parse(lines[2]!).type).toBe('turn');

    // get() returns null because no summary
    const result = await store.get(buffer.runId, 'session-1');
    expect(result).toBeNull();
  });

  test('completed trace with summary is fully recoverable', async () => {
    const store = new TraceStore(TEST_DIR);
    const buffer = new TraceBuffer('session-1', store);
    buffer.recordModelResponse({
      text: 'done',
      toolCalls: [],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });

    const trace = buffer.finalize('test-model');
    await store.finalize(trace);

    const recovered = await store.get(buffer.runId, 'session-1');
    expect(recovered).not.toBeNull();
    expect(recovered!.turns.length).toBe(1);
    expect(recovered!.summary.outcome).toBe('completed');
  });

  test('concurrent sub-agent traces are independent', async () => {
    const store = new TraceStore(TEST_DIR);

    const parent = new TraceBuffer('session-1', store);
    parent.recordModelResponse({
      text: 'spawning sub-agents',
      toolCalls: [{ name: 'sub_agent', arguments: { goal: 'task-a' } }],
      usage: { prompt_tokens: 30, completion_tokens: 15 },
    });

    const childA = new TraceBuffer('session-1', store, parent.runId);
    childA.recordModelResponse({
      text: 'sub-agent A work',
      toolCalls: [{ name: 'read', arguments: {} }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const childB = new TraceBuffer('session-1', store, parent.runId);
    childB.recordModelResponse({
      text: 'sub-agent B work',
      toolCalls: [{ name: 'grep', arguments: {} }],
      usage: { prompt_tokens: 8, completion_tokens: 4 },
    });

    // All three buffers have different runIds
    expect(parent.runId).not.toBe(childA.runId);
    expect(parent.runId).not.toBe(childB.runId);
    expect(childA.runId).not.toBe(childB.runId);

    // Child buffers link to parent
    expect(childA.parentRunId).toBe(parent.runId);
    expect(childB.parentRunId).toBe(parent.runId);

    // Parent buffer has no parentRunId
    expect(parent.parentRunId).toBeUndefined();

    // Finalize and verify independence
    await store.finalize(parent.finalize('test'));
    await store.finalize(childA.finalize('test'));
    await store.finalize(childB.finalize('test'));

    const parentTrace = await store.get(parent.runId, 'session-1');
    const childATrace = await store.get(childA.runId, 'session-1');
    const childBTrace = await store.get(childB.runId, 'session-1');

    expect(parentTrace!.turns[0]!.toolExecutions.length).toBe(0);
    expect(childATrace!.turns.length).toBe(1);
    expect(childBTrace!.turns.length).toBe(1);
  });
});
