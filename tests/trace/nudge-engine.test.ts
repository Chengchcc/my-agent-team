import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { NudgeEngine } from '../../src/trace/nudge-engine';
import type { TraceRun } from '../../src/trace/types';

const TEST_DIR = path.join(os.tmpdir(), `nudge-test-${Date.now()}`);
const STATE_PATH = path.join(TEST_DIR, 'state.json');

function makeRun(overrides: Partial<TraceRun> = {}): TraceRun {
  return {
    id: 'run-1', sessionId: 's1', startTime: 1000, endTime: 2000, model: 'test',
    turns: [],
    summary: { totalTurns: 0, totalToolCalls: 0, totalErrors: 0, totalTokens: {}, outcome: 'completed' },
    ...overrides,
  };
}

function errorTurn(toolName: string): TraceRun['turns'][number] {
  return {
    turnIndex: 0,
    toolExecutions: [{ toolName, success: false, durationMs: 10, error: 'fail' }],
  };
}

describe('NudgeEngine', () => {
  let engine: NudgeEngine;

  beforeEach(async () => {
    await fs.mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  test('returns null for a clean short run', () => {
    engine = new NudgeEngine(STATE_PATH);
    const result = engine.tick(makeRun({
      turns: [{ turnIndex: 0, toolExecutions: [{ toolName: 'read', success: true, durationMs: 5 }] }],
      summary: { totalTurns: 1, totalToolCalls: 1, totalErrors: 0, totalTokens: {}, outcome: 'completed' },
    }));
    expect(result).toBeNull();
  });

  test('triggers error_burst signal on >= 2 errors with ratio >= 0.3', () => {
    engine = new NudgeEngine(STATE_PATH);
    const run = makeRun({
      turns: [
        errorTurn('bash'),
        errorTurn('bash'),
        { turnIndex: 1, toolExecutions: [{ toolName: 'read', success: true, durationMs: 5 }] },
      ],
      summary: { totalTurns: 2, totalToolCalls: 3, totalErrors: 2, totalTokens: {}, outcome: 'completed' },
    });
    const result = engine.tick(run);
    expect(result).not.toBeNull();
    expect(result!.trigger).toBe('memory_review');
    expect(result!.reason).toContain('errors');
  });

  test('triggers complex_task signal on >= 5 turns with 0 errors', () => {
    engine = new NudgeEngine(STATE_PATH);
    const turns = Array.from({ length: 5 }, (_, i) => ({
      turnIndex: i,
      toolExecutions: [{ toolName: 'read', success: true, durationMs: 5 }],
    }));
    const run = makeRun({
      turns,
      summary: { totalTurns: 5, totalToolCalls: 5, totalErrors: 0, totalTokens: {}, outcome: 'completed' },
    });
    const result = engine.tick(run);
    expect(result).not.toBeNull();
    expect(result!.trigger).toBe('skill_review');
    expect(result!.reason).toContain('candidate for skill extraction');
  });

  test('error_burst + >=5 turns gives combined_review trigger', () => {
    engine = new NudgeEngine(STATE_PATH);
    const turns = [
      errorTurn('bash'),
      errorTurn('bash'),
      { turnIndex: 1, toolExecutions: [{ toolName: 'read', success: true, durationMs: 5 }] },
      { turnIndex: 2, toolExecutions: [{ toolName: 'read', success: true, durationMs: 5 }] },
      { turnIndex: 3, toolExecutions: [{ toolName: 'read', success: true, durationMs: 5 }] },
      { turnIndex: 4, toolExecutions: [{ toolName: 'read', success: true, durationMs: 5 }] },
    ];
    const run = makeRun({
      turns,
      summary: { totalTurns: 5, totalToolCalls: 6, totalErrors: 2, totalTokens: {}, outcome: 'completed' },
    });
    const result = engine.tick(run);
    expect(result).not.toBeNull();
    expect(result!.trigger).toBe('combined_review');
  });

  test('periodic signal fires after accumulated turns >= reviewInterval', () => {
    engine = new NudgeEngine(STATE_PATH, 3);
    const r1 = engine.tick(makeRun({
      turns: [{ turnIndex: 0, toolExecutions: [] }, { turnIndex: 1, toolExecutions: [] }],
      summary: { totalTurns: 2, totalToolCalls: 0, totalErrors: 0, totalTokens: {}, outcome: 'completed' },
    }));
    expect(r1).toBeNull();

    const r2 = engine.tick(makeRun({
      id: 'run-2',
      turns: [{ turnIndex: 0, toolExecutions: [] }, { turnIndex: 1, toolExecutions: [] }],
      summary: { totalTurns: 2, totalToolCalls: 0, totalErrors: 0, totalTokens: {}, outcome: 'completed' },
    }));
    expect(r2).not.toBeNull();
    expect(r2!.trigger).toBe('skill_review');
  });

  test('fingerprint dedup prevents repeated reviews of same error pattern', () => {
    engine = new NudgeEngine(STATE_PATH);
    const run = makeRun({
      turns: [errorTurn('bash'), errorTurn('bash'), { turnIndex: 1, toolExecutions: [{ toolName: 'read', success: true, durationMs: 5 }] }],
      summary: { totalTurns: 2, totalToolCalls: 3, totalErrors: 2, totalTokens: {}, outcome: 'completed' },
    });

    const first = engine.tick(run);
    expect(first).not.toBeNull();

    const second = engine.tick(run);
    expect(second).toBeNull();
  });

  test('persist and load state survives roundtrip', async () => {
    engine = new NudgeEngine(STATE_PATH, 5);
    engine.tick(makeRun({
      turns: [{ turnIndex: 0, toolExecutions: [] }, { turnIndex: 1, toolExecutions: [] }],
      summary: { totalTurns: 2, totalToolCalls: 0, totalErrors: 0, totalTokens: {}, outcome: 'completed' },
    }));
    await engine.persist();

    const engine2 = new NudgeEngine(STATE_PATH, 5);
    const r = engine2.tick(makeRun({
      turns: [{ turnIndex: 0, toolExecutions: [] }, { turnIndex: 1, toolExecutions: [] }, { turnIndex: 2, toolExecutions: [] }],
      summary: { totalTurns: 3, totalToolCalls: 0, totalErrors: 0, totalTokens: {}, outcome: 'completed' },
    }));
    expect(r).not.toBeNull();
  });

  test('MIN_REVIEW_INTERVAL_MS prevents review within 5 minutes', () => {
    engine = new NudgeEngine(STATE_PATH);
    const run = makeRun({
      turns: [errorTurn('bash'), errorTurn('bash'), { turnIndex: 1, toolExecutions: [{ toolName: 'read', success: true, durationMs: 5 }] }],
      summary: { totalTurns: 2, totalToolCalls: 3, totalErrors: 2, totalTokens: {}, outcome: 'completed' },
    });
    engine.tick(run);

    const second = engine.tick(makeRun({
      id: 'run-3',
      turns: [errorTurn('grep'), errorTurn('grep'), { turnIndex: 1, toolExecutions: [] }],
      summary: { totalTurns: 2, totalToolCalls: 2, totalErrors: 2, totalTokens: {}, outcome: 'completed' },
    }));
    expect(second).toBeNull();
  });
});
