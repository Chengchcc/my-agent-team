import { describe, test, expect } from 'bun:test';
import { buildReviewPrompt } from '../../src/evolution/prompt-templates';
import type { TraceRun } from '../../src/trace/types';

function makeTrace(overrides: Partial<TraceRun> = {}): TraceRun {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    startTime: Date.now(),
    endTime: Date.now(),
    model: 'test-model',
    turns: [
      {
        turnIndex: 0,
        userMessage: 'do something',
        modelResponse: {
          text: 'ok',
          toolCalls: [{ name: 'bash', arguments: { command: 'ls' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
        toolExecutions: [
          { toolName: 'bash', success: false, durationMs: 100, error: 'permission denied' },
        ],
      },
    ],
    summary: {
      totalTurns: 1, totalToolCalls: 1, totalErrors: 1,
      totalTokens: { prompt_tokens: 10, completion_tokens: 5 },
      outcome: 'error' as const,
    },
    ...overrides,
  };
}

describe('buildReviewPrompt', () => {
  test('error_burst prompt includes trace data and scoring instructions', () => {
    const trace = makeTrace();
    const prompt = buildReviewPrompt('error_burst', trace, []);

    expect(prompt).toContain('errors');
    expect(prompt).toContain('permission denied');
    expect(prompt).toContain('Score this pattern 1\u20135');
    expect(prompt).toContain('Nothing to save');
  });

  test('complex_task prompt includes workflow extraction instructions', () => {
    const trace = makeTrace({
      summary: { totalTurns: 5, totalToolCalls: 5, totalErrors: 0,
        totalTokens: { prompt_tokens: 50, completion_tokens: 25 }, outcome: 'completed' as const },
    });
    const prompt = buildReviewPrompt('complex_task', trace, []);

    expect(prompt).toContain('successful multi-step');
    expect(prompt).toContain('workflow');
    expect(prompt).toContain('Score this workflow');
  });

  test('periodic prompt references review interval', () => {
    const trace = makeTrace({
      summary: { ...makeTrace().summary, totalErrors: 0, outcome: 'completed' as const },
    });
    const prompt = buildReviewPrompt('periodic', trace, []);

    expect(prompt).toContain('Periodic review');
  });

  test('injects existing skill names for dedup', () => {
    const trace = makeTrace();
    const existingSkills = ['fix-permissions', 'bash-tricks'];
    const prompt = buildReviewPrompt('error_burst', trace, existingSkills);

    expect(prompt).toContain('fix-permissions');
    expect(prompt).toContain('bash-tricks');
    expect(prompt).toContain('do NOT duplicate');
  });

  test('handle empty trace gracefully', () => {
    const trace = makeTrace({
      turns: [],
      summary: { ...makeTrace().summary, totalTurns: 0, totalToolCalls: 0, totalErrors: 0 },
    });
    const prompt = buildReviewPrompt('error_burst', trace, []);

    expect(prompt).toContain('errors');
    expect(typeof prompt).toBe('string');
  });
});
