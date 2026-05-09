import { describe, test, expect } from 'bun:test';
import { ReviewSlot, type PendingReview } from '../../src/evolution/review-slot';

function makeTask(signal: string, priority: number): PendingReview {
  return { signal, priority, nudgeResult: { signal, trigger: 'skill_review', traceRunId: 'r1', sessionId: 's1', reason: 'test' }, trace: {} as any };
}

describe('ReviewSlot', () => {
  test('accepts task when empty', () => {
    const slot = new ReviewSlot();
    expect(slot.tryEnqueue(makeTask('error_burst', 1))).toBe(true);
  });

  test('higher priority replaces lower pending', () => {
    const slot = new ReviewSlot();
    slot.tryEnqueue(makeTask('periodic', 3));
    slot.markRunning();
    expect(slot.tryEnqueue(makeTask('error_burst', 1))).toBe(true);
    expect(slot.pending?.signal).toBe('error_burst');
  });

  test('lower priority rejected by higher priority pending', () => {
    const slot = new ReviewSlot();
    slot.tryEnqueue(makeTask('error_burst', 1));
    slot.markRunning(); // clears pending, slot is running
    slot.tryEnqueue(makeTask('error_burst', 1)); // pending = prio 1
    expect(slot.tryEnqueue(makeTask('periodic', 3))).toBe(false); // prio 3 > 1, rejected
  });

  test('markDone returns pending and clears running', () => {
    const slot = new ReviewSlot();
    slot.tryEnqueue(makeTask('complex_task', 2));
    slot.markRunning();
    slot.tryEnqueue(makeTask('periodic', 3));
    expect(slot.markDone()?.signal).toBe('periodic');
    expect(slot.running).toBe(false);
  });
});
