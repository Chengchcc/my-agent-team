import { describe, test, expect } from 'bun:test';
import { buildReviewPrompt } from '../../src/evolution/prompt-templates';
import type { TraceRun } from '../../src/trace/types';

function makeTrace(overrides: Partial<TraceRun> = {}): TraceRun {
  return {
    id: 'test-run',
    sessionId: 'test-session',
    startTime: Date.now(),
    endTime: Date.now(),
    model: 'test',
    turns: [],
    summary: { totalTurns: 5, totalToolCalls: 3, totalErrors: 2, totalTokens: {}, outcome: 'error' },
    ...overrides,
  };
}

describe('Review prompt data injection', () => {
  test('periodic prompt includes reviewInterval when provided', () => {
    const trace = makeTrace();
    const prompt = buildReviewPrompt('periodic', trace, [], 10);
    expect(prompt).toContain('Review interval: every 10 turns');
  });

  test('periodic prompt includes recentTraceSummaries when provided', () => {
    const trace = makeTrace();
    const prompt = buildReviewPrompt('periodic', trace, [], 10, [
      'Run abc: 5 turns, 0 errors, outcome: completed',
      'Run def: 3 turns, 1 errors, outcome: error',
    ]);
    expect(prompt).toContain('Run abc: 5 turns');
    expect(prompt).toContain('Run def: 3 turns');
  });

  test('periodic prompt shows (none) when no summaries provided', () => {
    const trace = makeTrace();
    const prompt = buildReviewPrompt('periodic', trace, [], 10);
    expect(prompt).toContain('(none)');
  });

  test('error_burst prompt does not need reviewInterval or summaries', () => {
    const trace = makeTrace();
    const prompt = buildReviewPrompt('error_burst', trace, []);
    expect(prompt).toContain('Total turns: 5');
    expect(prompt).toContain('Total errors: 2');
  });
});
