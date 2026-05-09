import { describe, test, expect, mock } from 'bun:test';
import { TurnSettledDetector } from '../../src/trace/turn-settled-detector';
import type { TraceSummary } from '../../src/trace/types';

const mockSummary: TraceSummary = {
  totalTurns: 5, totalToolCalls: 3, totalErrors: 0, totalTokens: {}, outcome: 'completed',
};

describe('TurnSettledDetector', () => {
  test('isActive when root running', () => {
    const detector = new TurnSettledDetector();
    detector.runStart(true, 'r1');
    expect(detector.isActive()).toBe(true);
  });

  test('isActive when sub running', () => {
    const detector = new TurnSettledDetector();
    detector.runStart(false, 's1');
    expect(detector.isActive()).toBe(true);
  });

  test('not active when all done', () => {
    const detector = new TurnSettledDetector();
    detector.runStart(true, 'r1');
    detector.runEnd(true, 'r1', mockSummary);
    expect(detector.isActive()).toBe(false);
  });

  test('emits settled after quiet period', async () => {
    const detector = new TurnSettledDetector();
    const settled = mock();
    detector.setCallback(settled);

    detector.runStart(true, 'r1');
    detector.runEnd(true, 'r1', mockSummary);

    await new Promise(r => setTimeout(r, 700));
    expect(settled).toHaveBeenCalled();
  });

  test('does not emit for aborted outcome', async () => {
    const detector = new TurnSettledDetector();
    const settled = mock();
    detector.setCallback(settled);

    detector.runStart(true, 'r1');
    detector.runEnd(true, 'r1', { ...mockSummary, outcome: 'aborted' });

    await new Promise(r => setTimeout(r, 700));
    expect(settled).not.toHaveBeenCalled();
  });

  test('tracks nested sub-agents correctly', () => {
    const detector = new TurnSettledDetector();
    detector.runStart(true, 'root');
    detector.runStart(false, 'sub1');
    detector.runStart(false, 'sub2');
    detector.runEnd(false, 'sub2', mockSummary);
    expect(detector.isActive()).toBe(true); // sub1 still running
    detector.runEnd(false, 'sub1', mockSummary);
    detector.runEnd(true, 'root', mockSummary);
    expect(detector.isActive()).toBe(false);
  });
});
