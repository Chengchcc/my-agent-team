import { debugLog } from '../utils/debug';

const BASE_DELAY_SECONDS = 30;
const MAX_DELAY_MINUTES = 15;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const BASE_DELAY_MS = BASE_DELAY_SECONDS * MS_PER_SECOND;
const MAX_DELAY_MS = MAX_DELAY_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;
const JITTER_FACTOR = 0.2;

export class ReviewBackoff {
  private failureCount = 0;
  private nextRunAt = 0;

  canRun(): boolean {
    return Date.now() >= this.nextRunAt;
  }

  nextDelay(): number {
    const raw = Math.min(BASE_DELAY_MS * Math.pow(2, this.failureCount), MAX_DELAY_MS);
    const jitter = raw * JITTER_FACTOR * (2 * Math.random() - 1);
    return Math.max(BASE_DELAY_MS, raw + jitter);
  }

  recordFailure(): void {
    const delay = this.nextDelay();
    this.nextRunAt = Date.now() + delay;
    this.failureCount++;
    debugLog(`[evolution] Review backoff: attempt ${this.failureCount}, next run in ${Math.round(delay / MS_PER_SECOND)}s`);
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.nextRunAt = 0;
  }
}
