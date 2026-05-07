import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { EffectivenessTracker } from '../../src/evolution/effectiveness-tracker';
import { buildAnalysisPrompt, parseVerdict, verdictToEvalCase } from '../../src/evolution/skill-analyzer';

const TEST_DIR = path.join(os.tmpdir(), `phase3-e2e-${Date.now()}`);

describe('Phase 3 integration', () => {
  afterEach(async () => { await fs.rm(TEST_DIR, { recursive: true, force: true }); });

  test('full mechanical scoring flow', async () => {
    const tracker = new EffectivenessTracker(TEST_DIR);
    let stats = await tracker.updateStats('s1', 'completed', 'r1');
    expect(stats.totalRuns).toBe(1);
    expect(stats.successRate).toBe(1);
    stats = await tracker.updateStats('s1', 'error', 'r2');
    stats = await tracker.updateStats('s1', 'error', 'r3');
    stats = await tracker.updateStats('s1', 'error', 'r4');
    expect(stats.totalRuns).toBe(4);
    expect(stats.successRate).toBe(0.25);
    expect(tracker.shouldTriggerReview(stats)).toBe(true);
  });

  test('Tier 2 prompt is generated for low-scoring skill', () => {
    const prompt = buildAnalysisPrompt('bad', 'desc', { totalRuns: 5, successfulRuns: 2, successRate: 0.4, lastRunId: 'x' }, [
      { outcome: 'error', traces: 'bash: denied' },
      { outcome: 'completed', traces: 'read: ok' },
    ]);
    expect(prompt).toContain('bad');
    expect(prompt).toContain('keep');
    expect(prompt).toContain('fix');
    expect(prompt).toContain('delete');
  });

  test('verdict to eval case conversion', () => {
    const v = parseVerdict(JSON.stringify({ verdict: 'fix', reasoning: 'Missing sudo', suggestion: 'Add sudo note' }));
    const c = verdictToEvalCase('s1', v!);
    expect(c?.should_trigger).toBe(true);
    expect(c?.expected_behavior).toContain('sudo');
  });

  test('keep verdict does not generate eval case', () => {
    const v = parseVerdict(JSON.stringify({ verdict: 'keep', reasoning: 'Fine' }));
    expect(verdictToEvalCase('s1', v!)).toBeNull();
  });
});
