/** Concurrency + budget gate for delegation spawns: a session-scoped
 *  semaphore bounded by maxConcurrent, plus the total-spawn cap and the
 *  optional product budget hook consulted before each spawn. */

export class GateError extends Error {}

export interface SpawnPool {
  acquire(signal?: AbortSignal): Promise<void>;
  release(): void;
  /** Throws GateError when the total cap or budget gate refuses a spawn. */
  gate(): void;
}

export function createSpawnPool(opts: {
  maxConcurrent: number;
  maxTotal: number;
  budgetGate?: () => { allowed: boolean; reason?: string };
}): SpawnPool {
  let totalSpawned = 0;
  let current = 0;
  const waiters: Array<() => void> = [];

  async function acquire(signal?: AbortSignal): Promise<void> {
    if (current < opts.maxConcurrent) {
      current++;
      return;
    }
    if (signal?.aborted) throw new Error("delegation aborted while queued");
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const idx = waiters.indexOf(fire);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error("delegation aborted while queued"));
      };
      const fire = (): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      waiters.push(fire);
      signal?.addEventListener("abort", onAbort, { once: true });
      // Cover the abort-between-check-and-listen race.
      if (signal?.aborted) onAbort();
    });
  }

  function release(): void {
    const next = waiters.shift();
    if (next) next();
    else current--;
  }

  function gate(): void {
    if (totalSpawned >= opts.maxTotal) {
      throw new GateError(`delegation exceeds the ${opts.maxTotal}-agent cap`);
    }
    if (opts.budgetGate) {
      const decision = opts.budgetGate();
      if (!decision.allowed) {
        throw new GateError(decision.reason ?? "delegation budget exhausted");
      }
    }
    totalSpawned++;
  }

  return { acquire, release, gate };
}
