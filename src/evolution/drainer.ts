import { debugLog } from '../utils/debug';
import type { EvolutionTaskKind, EvolutionTask } from './persistent-queue';
import type { PersistentQueue } from './persistent-queue';
import type { TierBreaker } from './tier-breaker';
import type { IdleGate } from './idle-gate';
import type { RunnerContext } from './review-runner';

const DRAIN_ORDER: EvolutionTaskKind[] = ['tier0_review', 'tier2_verdict', 'tier3_prompt_opt', 'tier3_ab_promote', 'auto_accept_sweep'];

const QUOTA: Record<EvolutionTaskKind, number> = {
  tier0_review: 3,
  tier2_verdict: 5,
  tier3_prompt_opt: 1,
  tier3_ab_promote: 1,
  auto_accept_sweep: 1,
};

export type TaskExecutor = (task: EvolutionTask, ctx: RunnerContext) => Promise<void>;

export class Drainer {
  private mutex = false;
  private queue: PersistentQueue;
  private breaker: TierBreaker;
  private idleGate: IdleGate;
  private executor: TaskExecutor | null = null;

  constructor(queue: PersistentQueue, breaker: TierBreaker, idleGate: IdleGate) {
    this.queue = queue;
    this.breaker = breaker;
    this.idleGate = idleGate;
  }

  setExecutor(fn: TaskExecutor): void {
    this.executor = fn;
  }

  async tryDrain(opts?: { force?: boolean }): Promise<number> {
    if (!opts?.force && !this.idleGate.canRun()) return 0;
    if (this.mutex) return 0;
    this.mutex = true;

    let drained = 0;
    try {
      for (const kind of DRAIN_ORDER) {
        if (this.breaker.isOpen(kind)) {
          debugLog(`[drainer] Skipping ${kind} — circuit open`);
          continue;
        }
        let quota = QUOTA[kind];
        while (quota > 0) {
          const task = await this.queue.claim(kind);
          if (!task) break;
          try {
            if (this.executor) {
              const ctx: RunnerContext = { softCancel: { value: false }, signal: new AbortController().signal };
              await this.executor(task, ctx);
            }
            await this.queue.complete(task.id, kind);
            this.breaker.recordSuccess(kind);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await this.queue.fail(task.id, kind, msg);
            this.breaker.recordFailure(kind);
          }
          quota--;
          drained++;
        }
      }
    } finally {
      this.mutex = false;
    }

    if (drained > 0) debugLog(`[drainer] Drained ${drained} tasks`);
    return drained;
  }
}
