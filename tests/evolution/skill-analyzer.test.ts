import { describe, test, expect } from 'bun:test';
import { buildAnalysisPrompt, parseVerdict, verdictToEvalCase } from '../../src/evolution/skill-analyzer';

describe('buildAnalysisPrompt', () => {
  test('includes skill name, success rate, and traces', () => {
    const prompt = buildAnalysisPrompt('s1', 'desc', { totalRuns: 5, successfulRuns: 2, successRate: 0.4, lastRunId: 'x' }, [
      { outcome: 'error', traces: 'bash: permission denied' },
    ]);
    expect(prompt).toContain('s1');
    expect(prompt).toContain('0.40');
    expect(prompt).toContain('permission denied');
    expect(prompt).toContain('keep');
    expect(prompt).toContain('fix');
    expect(prompt).toContain('delete');
  });
});

describe('parseVerdict', () => {
  test('parses keep', () => {
    expect(parseVerdict(JSON.stringify({ verdict: 'keep', reasoning: 'ok' }))?.verdict).toBe('keep');
  });
  test('parses fix with suggestion', () => {
    const v = parseVerdict(JSON.stringify({ verdict: 'fix', reasoning: 'r', suggestion: 's' }));
    expect(v?.verdict).toBe('fix');
    expect(v?.suggestion).toBe('s');
  });
  test('returns null for invalid', () => {
    expect(parseVerdict('not json')).toBeNull();
  });
});

describe('verdictToEvalCase', () => {
  test('fix verdict generates case', () => {
    const c = verdictToEvalCase('s1', { verdict: 'fix', reasoning: 'bad', suggestion: 'add sudo' });
    expect(c?.should_trigger).toBe(true);
    expect(c?.expected_behavior).toBe('add sudo');
  });
  test('keep verdict returns null', () => {
    expect(verdictToEvalCase('s1', { verdict: 'keep', reasoning: 'ok' })).toBeNull();
  });
});
