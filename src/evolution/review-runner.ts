import { debugLog } from '../utils/debug';

const HARD_ABORT_TIMEOUT_SECONDS = 10;
const MS_PER_SECOND = 1000;
const HARD_ABORT_TIMEOUT_MS = HARD_ABORT_TIMEOUT_SECONDS * MS_PER_SECOND;

export interface RunnerContext {
  softCancel: { value: boolean };
  signal: AbortSignal;
}

export class TaskRunner {
  softCancel = { value: false };
  private abortController: AbortController | null = null;

  run(
    task: (ctx: RunnerContext) => Promise<void>,
    callbacks?: { onComplete?: (() => void) | undefined; onError?: (() => void) | undefined },
  ): void {
    this.softCancel.value = false;
    this.abortController = new AbortController();
    const ctx: RunnerContext = {
      softCancel: this.softCancel,
      signal: this.abortController.signal,
    };

    const hardTimeout = setTimeout(() => {
      debugLog('[evolution] TaskRunner hard abort — timeout reached');
      this.abortController?.abort();
    }, HARD_ABORT_TIMEOUT_MS);

    void (async () => {
      try {
        await task(ctx);
      } catch (err) {
        debugLog(`[evolution] TaskRunner task error: ${err}`);
        callbacks?.onError?.();
      } finally {
        clearTimeout(hardTimeout);
        this.abortController = null;
        callbacks?.onComplete?.();
      }
    })();
  }

  cancel(): void {
    this.softCancel.value = true;
    debugLog('[evolution] TaskRunner soft cancel requested');
  }
}
