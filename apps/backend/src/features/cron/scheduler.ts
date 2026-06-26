import type { CronJob } from "bun";
import type { BackendConfig } from "../../config.js";
import type { AgentService } from "../agent/index.js";
import { executeAgentRun } from "../run/run-executor.js";
import type { RunSupervisor } from "../run/supervisor.js";
import type { RuntimeOpsStore } from "../runtime-ops/store.js";
import type { CronJobRow } from "./domain.js";
import type { CronJobService } from "./service.js";

export function createCronScheduler(deps: {
  cronSvc: CronJobService;
  config: BackendConfig;
  agentSvc: AgentService;
  supervisor: RunSupervisor;
  opsStore: RuntimeOpsStore;
  idGen: () => string;
  now?: () => number;
}) {
  const handles = new Map<string, CronJob>();
  /** runId → { timer, cronJobId } so unregister() can clear in-flight watchdogs. */
  const watchdogs = new Map<string, { timer: ReturnType<typeof setTimeout>; cronJobId: string }>();
  /** runIds cancelled by their per-job watchdog — excluded from retry (a job that
   *  always exceeds timeoutMs would otherwise burn every retry on the same timeout). */
  const timedOut = new Set<string>();
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  const retryCounts = new Map<string, number>();
  /** Single-flight lock per job. Held from a natural Bun.cron trigger until the
   *  whole fire chain (the run + any retries) settles. A natural trigger that
   *  arrives while the previous chain is still in flight is skipped, restoring
   *  the no-overlap guarantee that the decoupled (setTimeout) retry path would
   *  otherwise break. Retries do NOT re-acquire — they continue the held lock. */
  const inFlight = new Set<string>();

  async function fire(job: CronJobRow, _fireKey?: string): Promise<void> {
    const runId = deps.idGen();
    const threadId = `${job.cronJobId}:owner`;

    try {
      await executeAgentRun({
        runId,
        threadId,
        agentId: job.agentId,
        input: job.prompt ?? "",
        config: deps.config,
        agentSvc: deps.agentSvc,
        supervisor: deps.supervisor,
        opsStore: deps.opsStore,
        surface: "cron",
        senderName: "cron",
        originKind: "cron",
        origin: { cronJobId: job.cronJobId },
      });
    } catch (err) {
      inFlight.delete(job.cronJobId);
      throw err;
    }

    if (job.timeoutMs > 0) {
      const timer = setTimeout(() => {
        timedOut.add(runId);
        void deps.supervisor.cancel(runId);
      }, job.timeoutMs);
      watchdogs.set(runId, { timer, cronJobId: job.cronJobId });
    }
  }

  // Retry + watchdog cleanup listener.
  //
  // CRITICAL: supervisor.#runCompletionListeners awaits each listener
  // sequentially in a for-of loop.  Blocking here with await sleep(N)
  // would stall other listeners (ledger terminal write, lock release).
  //
  // Strategy: synchronous checks + cleanup run immediately; if a retry
  // is needed, schedule it via setTimeout so this callback returns
  // without blocking the listener loop.
  deps.supervisor.onRunComplete(async (_threadId, runId, status, _kind) => {
    // Clean watchdog timer if present
    const wd = watchdogs.get(runId);
    if (wd) {
      clearTimeout(wd.timer);
      watchdogs.delete(runId);
    }
    const wasTimedOut = timedOut.delete(runId);

    // Only handle cron runs
    const origin = deps.opsStore.getRunOrigin(runId);
    if (origin?.originKind !== "cron" || !origin.cronJobId) return;

    const fireKey = origin.idempotencyKey.split(":run:")[0]!;

    // No retry on success — clear any retry bookkeeping for this fire and
    // release the single-flight lock so the next natural trigger can fire.
    if (status === "succeeded") {
      retryCounts.delete(fireKey);
      inFlight.delete(origin.cronJobId);
      return;
    }

    // A run killed by its own per-job watchdog will time out again on retry;
    // don't burn maxRetries on the same deterministic timeout.
    if (wasTimedOut) {
      retryCounts.delete(fireKey);
      inFlight.delete(origin.cronJobId);
      return;
    }

    const job = deps.cronSvc.port.getCronJob(origin.cronJobId);
    if (!job || job.maxRetries <= 0) {
      inFlight.delete(origin.cronJobId);
      return;
    }
    const attempts = retryCounts.get(fireKey) ?? 0;
    if (attempts >= job.maxRetries) {
      retryCounts.delete(fireKey);
      inFlight.delete(origin.cronJobId);
      return;
    }

    retryCounts.set(fireKey, attempts + 1);
    deps.opsStore.appendRunEvent({
      runId,
      kind: "retry_requested",
      payload: { fireKey, attempt: attempts + 1 },
    });

    // Non-blocking exponential backoff: setTimeout + async IIFE so the
    // listener returns immediately.  The backoff delay does NOT stall
    // other onRunComplete listeners.
    const backoffMs = Math.min(1000 * 2 ** attempts, 30_000);
    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      void (async () => {
        deps.opsStore.appendRunEvent({
          runId,
          kind: "retry_started",
          payload: { fireKey, attempt: attempts + 1 },
        });
        await fire(job, fireKey).catch((err) =>
          console.error(`[cron] retry fire failed for ${job.cronJobId}:`, err),
        );
      })();
    }, backoffMs);
    retryTimers.add(timer);
  });

  return {
    start() {
      for (const job of deps.cronSvc.port.listEnabledCronJobs()) {
        // Isolate per-job registration: one bad cron expression must not abort
        // the whole startup loop and leave every later job unscheduled.
        try {
          this.register(job);
        } catch (err) {
          console.error(`[cron] register failed for ${job.cronJobId}:`, err);
        }
      }
    },

    register(job: CronJobRow) {
      this.unregister(job.cronJobId);
      if (!job.enabled) return;
      handles.set(
        job.cronJobId,
        Bun.cron(job.cronExpr, () => {
          // Single-flight: a natural trigger that arrives while the previous
          // fire chain (run + retries) is still in flight is skipped. This
          // restores the no-overlap guarantee that the decoupled (setTimeout)
          // retry path would otherwise break. The lock is released by the
          // onRunComplete listener once the chain settles, or by fire()'s
          // catch if buildSpec/dispatch never produced a run.
          if (inFlight.has(job.cronJobId)) return;
          inFlight.add(job.cronJobId);
          fire(job).catch((err) => console.error(`[cron] fire failed for ${job.cronJobId}:`, err));
        }),
      );
    },

    unregister(cronJobId: string) {
      const h = handles.get(cronJobId);
      if (h) {
        h.stop();
        handles.delete(cronJobId);
      }
      // Clear any in-flight watchdog timers owned by this job.
      for (const [runId, wd] of watchdogs) {
        if (wd.cronJobId === cronJobId) {
          clearTimeout(wd.timer);
          watchdogs.delete(runId);
          timedOut.delete(runId);
        }
      }
      // Drop the single-flight lock so a re-registered job can fire immediately.
      inFlight.delete(cronJobId);
    },

    dispose() {
      for (const h of handles.values()) h.stop();
      handles.clear();
      for (const wd of watchdogs.values()) clearTimeout(wd.timer);
      watchdogs.clear();
      timedOut.clear();
      for (const t of retryTimers) clearTimeout(t);
      retryTimers.clear();
      retryCounts.clear();
      inFlight.clear();
    },
  };
}

export type CronScheduler = ReturnType<typeof createCronScheduler>;
