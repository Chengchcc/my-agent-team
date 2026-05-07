import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { EffectivenessTracker } from '../../src/evolution/effectiveness-tracker';

const TEST_DIR = path.join(os.tmpdir(), `effectiveness-${Date.now()}`);

describe('EffectivenessTracker', () => {
  afterEach(async () => { await fs.rm(TEST_DIR, { recursive: true, force: true }); });

  test('writes and reads status.json', async () => {
    const tracker = new EffectivenessTracker(TEST_DIR);
    const status = { skillName: 't', status: 'pending' as const, createdAt: Date.now(), sourceRunId: 'r1' };
    await tracker.saveStatus(status);
    const read = await tracker.loadStatus('t');
    expect(read).not.toBeNull();
    expect(read!.status).toBe('pending');
  });

  test('loadStatus returns null for missing file', async () => {
    const tracker = new EffectivenessTracker(TEST_DIR);
    expect(await tracker.loadStatus('nope')).toBeNull();
  });

  test('shouldTriggerReview true when score low and enough runs', () => {
    const tracker = new EffectivenessTracker(TEST_DIR);
    expect(tracker.shouldTriggerReview({ totalRuns: 5, successfulRuns: 2, successRate: 0.4, lastRunId: 'x' })).toBe(true);
    expect(tracker.shouldTriggerReview({ totalRuns: 5, successfulRuns: 4, successRate: 0.8, lastRunId: 'x' })).toBe(false);
    expect(tracker.shouldTriggerReview({ totalRuns: 2, successfulRuns: 0, successRate: 0, lastRunId: 'x' })).toBe(false);
  });

  test('updateStats increments counters correctly', async () => {
    const tracker = new EffectivenessTracker(TEST_DIR);
    await tracker.updateStats('s', 'completed', 'r1');
    await tracker.updateStats('s', 'error', 'r2');
    await tracker.updateStats('s', 'completed', 'r3');
    const status = await tracker.loadStatus('s');
    expect(status!.stats!.totalRuns).toBe(3);
    expect(status!.stats!.successfulRuns).toBe(2);
  });
});
