import { describe, test, expect } from 'bun:test';
import { ReviewBackoff } from '../../src/evolution/review-backoff';

describe('ReviewBackoff', () => {
  test('allows execution with no failures', () => {
    expect(new ReviewBackoff().canRun()).toBe(true);
  });

  test('delays after failure', () => {
    const backoff = new ReviewBackoff();
    backoff.recordFailure();
    expect(backoff.canRun()).toBe(false);
  });

  test('resets on success', () => {
    const backoff = new ReviewBackoff();
    backoff.recordFailure();
    backoff.recordSuccess();
    expect(backoff.canRun()).toBe(true);
  });

  test('delays increase monotonically', () => {
    const backoff = new ReviewBackoff();
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      delays.push(backoff.nextDelay());
      backoff.recordFailure();
    }
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    }
  });
});
