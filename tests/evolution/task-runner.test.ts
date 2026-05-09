import { describe, test, expect } from 'bun:test';
import { TaskRunner } from '../../src/evolution/review-runner';

describe('TaskRunner', () => {
  test('runs task and calls onComplete', async () => {
    const runner = new TaskRunner();
    let completed = false;
    await new Promise<void>((resolve) => {
      runner.run(
        async () => { /* success */ },
        { onComplete: () => { completed = true; resolve(); } },
      );
    });
    expect(completed).toBe(true);
  });

  test('calls onError when task throws', async () => {
    const runner = new TaskRunner();
    let errored = false;
    await new Promise<void>((resolve) => {
      runner.run(
        async () => { throw new Error('test failure'); },
        {
          onComplete: () => resolve(),
          onError: () => { errored = true; },
        },
      );
    });
    expect(errored).toBe(true);
  });

  test('softCancel is set on cancel()', () => {
    const runner = new TaskRunner();
    expect(runner.softCancel.value).toBe(false);
    runner.cancel();
    expect(runner.softCancel.value).toBe(true);
  });

  test('task receives runner context', async () => {
    const runner = new TaskRunner();
    let receivedCtx = false;
    await new Promise<void>((resolve) => {
      runner.run(
        async (ctx) => {
          expect(ctx.softCancel).toBeDefined();
          expect(ctx.signal).toBeDefined();
          receivedCtx = true;
        },
        { onComplete: () => resolve() },
      );
    });
    expect(receivedCtx).toBe(true);
  });
});
