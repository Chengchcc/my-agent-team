import { debugLog } from '../utils/debug';
import type { EvolutionTaskKind } from './persistent-queue';
import type { TraceSummary } from '../trace/types';

export type SettleEvent =
  | { kind: 'main_loop_settled'; summary: TraceSummary }
  | { kind: 'task_completed'; taskId: string; taskKind: EvolutionTaskKind }
  | { kind: 'idle_window_open' }
  | { kind: 'cron_fired'; schedule: string };

type SettleCallback = (event: SettleEvent) => void;

export class SettleBus {
  private listeners: SettleCallback[] = [];

  on(cb: SettleCallback): () => void {
    this.listeners.push(cb);
    return () => { this.listeners = this.listeners.filter(l => l !== cb); };
  }

  emit(event: SettleEvent): void {
    debugLog(`[SettleBus] ${event.kind}${event.kind === 'task_completed' ? ` (${event.taskKind})` : ''}`);
    for (const cb of this.listeners) {
      try { cb(event); } catch { /* don't let one bad listener break others */ }
    }
  }
}
