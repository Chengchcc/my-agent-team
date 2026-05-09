import { debugLog } from '../utils/debug';

const MS_PER_SECOND = 1000;
const DEFAULT_HARD_ABORT_SECONDS = 10;

export interface RunnerContext {
  softCancel: { value: boolean };
  signal: AbortSignal;
}

export type RunnerOutcome =
  | { result: 'success'; detail?: string }
  | { result: 'soft_abort'; detail?: string }
  | { result: 'hard_abort'; detail?: string }
  | { result: 'error'; detail?: string };

export type CancelPolicy = 'preempt' | 'graceful' | 'finish';

export class TaskRunner {
  softCancel = { value: false };
  private abortController: AbortController | null = null;
  private readonly hardAbortMs: number;

  constructor(hardAbortSeconds?: number) {
    this.hardAbortMs = (hardAbortSeconds ?? DEFAULT_HARD_ABORT_SECONDS) * MS_PER_SECOND;
  }

  run(
    task: (ctx: RunnerContext) => Promise<RunnerOutcome>,
    callbacks?: { onComplete?: ((outcome: RunnerOutcome) => void) | undefined; onError?: ((err: string) => void) | undefined },
  ): void {
    this.softCancel.value = false;
    this.abortController = new AbortController();
    const ctx: RunnerContext = { softCancel: this.softCancel, signal: this.abortController.signal };

    const hardTimeout = setTimeout(() => {
      debugLog('[evolution] TaskRunner hard abort — timeout reached');
      this.abortController?.abort();
    }, this.hardAbortMs);

    void (async () => {
      let outcome: RunnerOutcome = { result: 'error', detail: 'unknown' };
      try {
        outcome = await task(ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debugLog(`[evolution] TaskRunner task error: ${msg}`);
        outcome = { result: 'error', detail: msg };
        callbacks?.onError?.(msg);
      } finally {
        clearTimeout(hardTimeout);
        this.abortController = null;
        callbacks?.onComplete?.(outcome);
      }
    })();
  }

  cancel(): void {
    this.softCancel.value = true;
    debugLog('[evolution] TaskRunner soft cancel requested');
  }
}
