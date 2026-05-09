import type { TraceRun } from '../trace/types';

export interface PendingReview {
  signal: string;
  priority: number;
  nudgeResult: { signal: string; trigger: string; traceRunId: string; sessionId: string; reason: string };
  trace: TraceRun;
}

const DEFAULT_PRIORITY = 3;
const SIGNAL_PRIORITY: Record<string, number> = {
  error_burst: 1,
  complex_task: 2,
  periodic: DEFAULT_PRIORITY,
};

export class ReviewSlot {
  running = false;
  pending: PendingReview | null = null;

  tryEnqueue(task: PendingReview): boolean {
    if (!this.running) {
      this.pending = task;
      return true;
    }
    if (!this.pending) {
      this.pending = task;
      return true;
    }
    if (task.priority < this.pending.priority) {
      this.pending = task;
      return true;
    }
    return false;
  }

  markRunning(): void {
    this.running = true;
    this.pending = null;
  }

  markDone(): PendingReview | null {
    this.running = false;
    const next = this.pending;
    this.pending = null;
    return next;
  }
}

export function signalPriority(signal: string): number {
  return SIGNAL_PRIORITY[signal] ?? DEFAULT_PRIORITY;
}
