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
  // -----------------------------------------------------------------------
  // Existing tests (preserved, still valid)
  // -----------------------------------------------------------------------

  test('error_burst prompt includes trace data and scoring instructions', () => {
    const trace = makeTrace();
    const prompt = buildReviewPrompt('error_burst', trace, []);

    expect(prompt).toContain('errors');
    expect(prompt).toContain('permission denied');
    expect(prompt).toContain('Score reusability');
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
    expect(prompt).toContain('Score reusability');
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

  // -----------------------------------------------------------------------
  // New tests: error_burst methodology
  // -----------------------------------------------------------------------

  test('error_burst prompt includes WHY explanation', () => {
    const trace = makeTrace();
    const prompt = buildReviewPrompt('error_burst', trace, []);

    expect(prompt).toContain('Why this matters');
    expect(prompt).toContain('recovery workflow');
    expect(prompt).toContain('reinventing a fix');
  });

  test('error_burst prompt includes scoring examples', () => {
    const trace = makeTrace();
    const prompt = buildReviewPrompt('error_burst', trace, []);

    // Should have scoring scale with concrete examples
    expect(prompt).toContain('Score reusability');
    expect(prompt).toContain('Score 1-2');
    expect(prompt).toContain('Score 4-5');
    expect(prompt).toContain('npm instal'); // example of trivial mistake
    expect(prompt).toContain('4-turn saga'); // example of high-value pattern
  });

  test('error_burst prompt includes methodology steps', () => {
    const trace = makeTrace();
    const prompt = buildReviewPrompt('error_burst', trace, []);

    expect(prompt).toContain('Understand the failure pattern');
    expect(prompt).toContain('Score reusability');
    expect(prompt).toContain('Decide');
  });

  test('error_burst prompt includes anti-patterns and pitfalls', () => {
    const trace = makeTrace();
    const prompt = buildReviewPrompt('error_burst', trace, []);

    expect(prompt).toContain('Pitfalls to avoid');
    expect(prompt).toContain('Overfitting to the trace');
    expect(prompt).toContain('Recipe without reasoning');
    expect(prompt).toContain('Good vs bad skills');
    expect(prompt).toContain('portable-grep');
  });

  test('error_burst prompt includes good vs bad skill examples', () => {
    const trace = makeTrace();
    const prompt = buildReviewPrompt('error_burst', trace, []);

    expect(prompt).toContain('Good skill');
    expect(prompt).toContain('Bad skill');
    expect(prompt).toContain('memorizing a one-off');
  });

  // -----------------------------------------------------------------------
  // New tests: complex_task methodology
  // -----------------------------------------------------------------------

  test('complex_task prompt includes investigation/action/verification phases', () => {
    const trace = makeTrace({
      summary: { totalTurns: 5, totalToolCalls: 5, totalErrors: 0,
        totalTokens: { prompt_tokens: 50, completion_tokens: 25 }, outcome: 'completed' as const },
    });
    const prompt = buildReviewPrompt('complex_task', trace, []);

    expect(prompt).toContain('Investigation phase');
    expect(prompt).toContain('Action phase');
    expect(prompt).toContain('Verification phase');
  });

  test('complex_task prompt includes reusability scoring with examples', () => {
    const trace = makeTrace({
      summary: { totalTurns: 5, totalToolCalls: 5, totalErrors: 0,
        totalTokens: { prompt_tokens: 50, completion_tokens: 25 }, outcome: 'completed' as const },
    });
    const prompt = buildReviewPrompt('complex_task', trace, []);

    expect(prompt).toContain('Score reusability');
    expect(prompt).toContain('Score 1-2');
    expect(prompt).toContain('Score 4-5');
    // Should have a concrete example
    expect(prompt).toContain('rename variable');
  });

  test('complex_task prompt includes skill design guidance', () => {
    const trace = makeTrace({
      summary: { totalTurns: 5, totalToolCalls: 5, totalErrors: 0,
        totalTokens: { prompt_tokens: 50, completion_tokens: 25 }, outcome: 'completed' as const },
    });
    const prompt = buildReviewPrompt('complex_task', trace, []);

    expect(prompt).toContain('Design the skill');
    expect(prompt).toContain('Trigger description');
    expect(prompt).toContain('Workarounds and pitfalls');
    expect(prompt).toContain('Edge cases');
  });

  test('complex_task prompt includes anti-patterns', () => {
    const trace = makeTrace({
      summary: { totalTurns: 5, totalToolCalls: 5, totalErrors: 0,
        totalTokens: { prompt_tokens: 50, completion_tokens: 25 }, outcome: 'completed' as const },
    });
    const prompt = buildReviewPrompt('complex_task', trace, []);

    expect(prompt).toContain('Skill design anti-patterns');
    expect(prompt).toContain('Step-by-step without context');
    expect(prompt).toContain('Too narrow');
    expect(prompt).toContain('Too broad');
  });

  // -----------------------------------------------------------------------
  // New tests: periodic methodology
  // -----------------------------------------------------------------------

  test('periodic prompt includes cross-run pattern analysis guidance', () => {
    const trace = makeTrace({
      summary: { ...makeTrace().summary, totalErrors: 0, outcome: 'completed' as const },
    });
    const prompt = buildReviewPrompt('periodic', trace, []);

    expect(prompt).toContain('cross-run patterns');
    expect(prompt).toContain('recurring themes');
    expect(prompt).toContain('Same tool failing');
    expect(prompt).toContain('Same multi-turn recovery');
  });

  test('periodic prompt includes false pattern warnings', () => {
    const trace = makeTrace({
      summary: { ...makeTrace().summary, totalErrors: 0, outcome: 'completed' as const },
    });
    const prompt = buildReviewPrompt('periodic', trace, []);

    expect(prompt).toContain('Avoid false patterns');
    expect(prompt).toContain('root cause');
    expect(prompt).toContain('Coincidental overlap');
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  test('error_burst with no failed tools shows "none"', () => {
    const trace = makeTrace({
      turns: [{
        turnIndex: 0,
        modelResponse: {
          text: 'ok',
          toolCalls: [{ name: 'bash', arguments: { command: 'ls' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
        toolExecutions: [
          { toolName: 'bash', success: true, durationMs: 50 },
        ],
      }],
      summary: { ...makeTrace().summary, totalErrors: 0, outcome: 'completed' as const },
    });
    const prompt = buildReviewPrompt('error_burst', trace, []);

    expect(prompt).toContain('none');
  });

  test('periodic prompt with reviewInterval injects the value', () => {
    const trace = makeTrace({
      summary: { ...makeTrace().summary, totalErrors: 0, outcome: 'completed' as const },
    });
    const prompt = buildReviewPrompt('periodic', trace, [], 25);

    expect(prompt).toContain('every 25 turns');
  });

  test('periodic prompt with recentTraceSummaries includes them', () => {
    const trace = makeTrace({
      summary: { ...makeTrace().summary, totalErrors: 0, outcome: 'completed' as const },
    });
    const summaries = ['Session 1: 3 turns, 0 errors', 'Session 2: 5 turns, 1 error'];
    const prompt = buildReviewPrompt('periodic', trace, [], 10, summaries);

    expect(prompt).toContain('Session 1: 3 turns, 0 errors');
    expect(prompt).toContain('Session 2: 5 turns, 1 error');
  });
});
