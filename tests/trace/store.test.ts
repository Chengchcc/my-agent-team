import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { TraceStore } from '../../src/trace/store';
import type { TraceRun } from '../../src/trace/types';

const TEST_DIR = path.join(os.tmpdir(), `trace-store-test-${Date.now()}`);

function makeTrace(overrides: Partial<TraceRun> = {}): TraceRun {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    startTime: 1000,
    endTime: 2000,
    model: 'test-model',
    turns: [],
    summary: { totalTurns: 0, totalToolCalls: 0, totalErrors: 0, totalTokens: {}, outcome: 'completed' },
    ...overrides,
  };
}

describe('TraceStore', () => {
  let store: TraceStore;

  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
    store = new TraceStore(TEST_DIR);
  });

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  test('listRecent orders sessions by modification time (newest first)', async () => {
    const now = Date.now();

    // Create three session dirs and set explicit mtimes to guarantee ordering
    await fs.mkdir(path.join(TEST_DIR, 'session-old'), { recursive: true });
    await fs.mkdir(path.join(TEST_DIR, 'session-mid'), { recursive: true });
    await fs.mkdir(path.join(TEST_DIR, 'session-new'), { recursive: true });

    // Also create a finalized run in each so listRecent returns them
    for (const sessionId of ['session-old', 'session-mid', 'session-new']) {
      const trace = makeTrace({ id: 'run-1', sessionId });
      await store.appendTurn('run-1', sessionId, { type: 'turn', turnIndex: 0, toolExecutions: [] });
      await store.finalize(trace);
    }

    // Set explicit mtimes on session directories: oldest, middle, newest
    const oldTime = new Date(now - 30000);
    const midTime = new Date(now - 15000);
    const newTime = new Date(now);

    await fs.utimes(path.join(TEST_DIR, 'session-old'), oldTime, oldTime);
    await fs.utimes(path.join(TEST_DIR, 'session-mid'), midTime, midTime);
    await fs.utimes(path.join(TEST_DIR, 'session-new'), newTime, newTime);

    const recent = await store.listRecent(10, 1);
    const sessionIds = recent.map(r => r.sessionId);
    expect(sessionIds).toEqual(['session-new', 'session-mid', 'session-old']);
  });

  test('appendTurn writes a line to the NDJSON file', async () => {
    await store.appendTurn('run-1', 'session-1', {
      type: 'turn', turnIndex: 0, userMessage: 'hello', toolExecutions: [],
    });

    const filePath = path.join(TEST_DIR, 'session-1', 'run-1.jsonl');
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.type).toBe('turn');
    expect(parsed.turnIndex).toBe(0);
  });

  test('finalize writes summary line and stores completed trace', async () => {
    await store.appendTurn('run-1', 'session-1', {
      type: 'turn', turnIndex: 0, toolExecutions: [],
    });
    const trace = makeTrace({
      id: 'run-1', sessionId: 'session-1',
      turns: [{ turnIndex: 0, toolExecutions: [] }],
      summary: { totalTurns: 1, totalToolCalls: 0, totalErrors: 0, totalTokens: {}, outcome: 'completed' },
    });

    await store.finalize(trace);

    const filePath = path.join(TEST_DIR, 'session-1', 'run-1.jsonl');
    const content = await fs.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2);
    const summaryLine = JSON.parse(lines[1]!);
    expect(summaryLine.type).toBe('summary');
    expect(summaryLine.totalTurns).toBe(1);
  });

  test('get reconstructs a full TraceRun from NDJSON lines', async () => {
    await store.appendTurn('run-1', 'session-1', {
      type: 'turn', turnIndex: 0, userMessage: 'hello', toolExecutions: [],
    });
    await store.appendTurn('run-1', 'session-1', {
      type: 'tool', toolName: 'bash', success: true, durationMs: 42,
    });
    const trace = makeTrace({
      id: 'run-1', sessionId: 'session-1',
      turns: [{ turnIndex: 0, userMessage: 'hello', toolExecutions: [{ toolName: 'bash', success: true, durationMs: 42 }] }],
    });
    await store.finalize(trace);

    const reconstructed = await store.get('run-1', 'session-1');
    expect(reconstructed).not.toBeNull();
    expect(reconstructed!.turns.length).toBe(1);
    expect(reconstructed!.turns[0]!.toolExecutions.length).toBe(1);
    expect(reconstructed!.summary.outcome).toBe('completed');
  });

  test('listBySession returns run IDs', async () => {
    const trace1 = makeTrace({ id: 'run-1', sessionId: 'session-1' });
    const trace2 = makeTrace({ id: 'run-2', sessionId: 'session-1' });
    await store.appendTurn('run-1', 'session-1', { type: 'turn', turnIndex: 0, toolExecutions: [] });
    await store.finalize(trace1);
    await store.appendTurn('run-2', 'session-1', { type: 'turn', turnIndex: 0, toolExecutions: [] });
    await store.finalize(trace2);

    const runs = await store.listBySession('session-1');
    expect(runs.length).toBe(2);
    expect(runs).toContain('run-1');
    expect(runs).toContain('run-2');
  });

  test('retention deletes oldest runs when exceeding maxRunsPerSession', async () => {
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    store = new TraceStore(TEST_DIR, 2);
    for (let i = 0; i < 3; i++) {
      const runId = `run-${i}`;
      await store.appendTurn(runId, 'session-1', { type: 'turn', turnIndex: 0, toolExecutions: [] });
      await store.finalize(makeTrace({ id: runId, sessionId: 'session-1' }));
      await sleep(30);
    }
    const runs = await store.listBySession('session-1');
    expect(runs.length).toBe(2);
    expect(runs).not.toContain('run-0');
  });

  test('get returns null for nonexistent run', async () => {
    const result = await store.get('nonexistent', 'session-1');
    expect(result).toBeNull();
  });
});
