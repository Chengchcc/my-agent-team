import type { TraceSummary } from './types';
import { debugLog } from '../utils/debug';

const QUIET_WINDOW_MS = 500;
const TICK_INTERVAL_MS = 100;

type SettledCallback = (summary: TraceSummary) => void;

const BLOCKED_OUTCOMES = new Set<TraceSummary['outcome']>(['aborted', 'cleared', 'compacted_mid']);

export class TurnSettledDetector {
  private rootRunning = false;
  private subRunningCount = 0;
  private lastEventAt = 0;
  private onSettled: SettledCallback | null = null;
  private loopSummary: TraceSummary | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  setCallback(cb: SettledCallback): void {
    this.onSettled = cb;
  }

  runStart(root: boolean, _runId: string): void {
    if (root) {
      this.rootRunning = true;
    } else {
      this.subRunningCount++;
    }
  }

  runEnd(root: boolean, _runId: string, summary: TraceSummary): void {
    if (root) {
      this.rootRunning = false;
      this.loopSummary = summary;
    } else {
      this.subRunningCount = Math.max(0, this.subRunningCount - 1);
    }
    this.lastEventAt = Date.now();

    // Start ticker if not already running
    if (!this.tickTimer) {
      this.tickTimer = setInterval(() => this.evaluate(), TICK_INTERVAL_MS);
      this.tickTimer.unref();
    }
  }

  private evaluate(): void {
    if (this.rootRunning || this.subRunningCount > 0) return;
    if (Date.now() - this.lastEventAt < QUIET_WINDOW_MS) return;
    if (!this.loopSummary) return;

    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    const outcome = this.loopSummary.outcome;
    if (BLOCKED_OUTCOMES.has(outcome)) {
      debugLog(`[trace] loop_settled suppressed — outcome: ${outcome}`);
      this.loopSummary = null;
      return;
    }

    debugLog(`[trace] loop_settled emitted — ${this.loopSummary.totalTurns} turns`);
    this.onSettled?.(this.loopSummary);
    this.loopSummary = null;
  }

  isActive(): boolean {
    return this.rootRunning || this.subRunningCount > 0;
  }
}
