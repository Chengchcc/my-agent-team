import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface WorkspaceLockRegistry {
  /** Serialize fn against every other withLock caller on the same root
   *  (after path normalization). Rejections in fn propagate; the lock is
   *  always released. `note` names the caller in the long-wait warning. */
  withLock<T>(root: string, fn: () => Promise<T>, note?: string): Promise<T>;
  /** True while a withLock fn is executing on this root. */
  isLocked(root: string): boolean;
}

/** Normalize the lock key: realpath when the path exists (macOS /private,
 *  symlinked workspaces), resolved absolute otherwise. */
function lockKey(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

/** Per-workspace mutex for run dispatch (ADR 0023 §5): one caller today — the
 *  same-workspace spawns serialize — with a hold scoped by workspace kind
 *  (#59: a shared checkout holds for the run's whole life, an agent's own
 *  directory only through delivery). One promise-chain tail per root; the
 *  chain entry is removed when the last waiter settles, so the map cannot
 *  grow across runs. */
export function createWorkspaceLockRegistry(
  opts: { waitWarnMs?: number } = {},
): WorkspaceLockRegistry {
  const waitWarnMs = opts.waitWarnMs ?? 30_000;
  /** root key → completion tail of the newest waiter (chained). */
  const tails = new Map<string, Promise<void>>();
  /** root keys whose fn is currently executing. */
  const live = new Set<string>();

  return {
    isLocked(root: string): boolean {
      return live.has(lockKey(root));
    },

    async withLock<T>(root: string, fn: () => Promise<T>, note?: string): Promise<T> {
      const key = lockKey(root);
      const prev = tails.get(key) ?? Promise.resolve();
      const { promise: gate, resolve: open } = Promise.withResolvers<void>();
      const tail = prev.then(() => gate);
      // The chain entry is the queue: whoever queues behind one waits on it. (`live` alone
      // cannot say this — the holder marks itself one microtask later.)
      const queued = tails.has(key);
      tails.set(key, tail);
      // A holder parked on a HITL ask keeps this key for as long as the human
      // takes (#59): waiting is then correct but invisible, so a long wait is
      // said out loud instead of leaving a silently-"running" run.
      const startedAt = Date.now();
      const warn = queued
        ? setTimeout(() => {
            console.warn(
              `[workspace-lock] ${note ?? "a caller"} waited ${Date.now() - startedAt}ms on ${key}: another run holds this workspace (a run parked on a human ask holds it until answered).`,
            );
          }, waitWarnMs)
        : undefined;
      await prev.catch(() => {
        /* a failed predecessor must not fail this waiter */
      });
      live.add(key);
      try {
        return await fn();
      } finally {
        if (warn) clearTimeout(warn);
        live.delete(key);
        // Only drop the chain entry when no newer waiter replaced it.
        if (tails.get(key) === tail) tails.delete(key);
        open();
      }
    },
  };
}
