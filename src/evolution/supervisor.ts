import type { EvolutionTask, EvolutionTaskKind } from './persistent-queue';
import type { SettleBus, SettleEvent } from './settle-bus';
import type { CancelPolicy } from './review-runner';
import { debugLog } from '../utils/debug';

interface RunningTask {
  task: EvolutionTask;
  cancelPolicy: CancelPolicy;
  softCancel: () => void;
}

const CANCEL_POLICY: Record<EvolutionTaskKind, CancelPolicy> = {
  tier0_review: 'preempt',
  tier2_verdict: 'graceful',
  tier3_prompt_opt: 'graceful',
  tier3_ab_promote: 'finish',
  auto_accept_sweep: 'finish',
};

const MS_PER_SECOND = 1000;
const TIER0_GRACE_SECONDS = 10;
const TIER2_GRACE_SECONDS = 30;
const TIER3_GRACE_SECONDS = 60;
const SWEEP_GRACE_SECONDS = 5;
const SOFT_CANCEL_GRACE_MS: Record<EvolutionTaskKind, number> = {
  tier0_review: TIER0_GRACE_SECONDS * MS_PER_SECOND,
  tier2_verdict: TIER2_GRACE_SECONDS * MS_PER_SECOND,
  tier3_prompt_opt: TIER3_GRACE_SECONDS * MS_PER_SECOND,
  tier3_ab_promote: SWEEP_GRACE_SECONDS * MS_PER_SECOND,
  auto_accept_sweep: SWEEP_GRACE_SECONDS * MS_PER_SECOND,
};

export class Supervisor {
  private current: RunningTask | null = null;

  constructor(bus: SettleBus) {
    bus.on((event) => this.handleSettle(event));
  }

  setCurrent(task: EvolutionTask | null, softCancel: () => void): void {
    if (task) {
      this.current = { task, cancelPolicy: CANCEL_POLICY[task.kind], softCancel };
      debugLog(`[Supervisor] Running ${task.kind} (${this.current.cancelPolicy})`);
    } else {
      this.current = null;
    }
  }

  isBusy(): boolean {
    return this.current !== null;
  }

  currentKind(): EvolutionTaskKind | null {
    return this.current?.task.kind ?? null;
  }

  private handleSettle(event: SettleEvent): void {
    if (event.kind !== 'main_loop_settled') return;
    if (!this.current) return;

    switch (this.current.cancelPolicy) {
      case 'preempt': {
        debugLog(`[Supervisor] Preempting ${this.current.task.kind} — main loop started`);
        this.current.softCancel();
        setTimeout(() => {
          // Hard abort will fire via TaskRunner's AbortController
          debugLog(`[Supervisor] Hard abort grace elapsed for ${this.current?.task.kind}`);
        }, SOFT_CANCEL_GRACE_MS[this.current.task.kind]);
        break;
      }
      case 'graceful': {
        debugLog(`[Supervisor] Graceful pause for ${this.current.task.kind}`);
        this.current.softCancel();
        break;
      }
      case 'finish':
        debugLog(`[Supervisor] Letting ${this.current.task.kind} finish naturally`);
        break;
    }
  }
}
