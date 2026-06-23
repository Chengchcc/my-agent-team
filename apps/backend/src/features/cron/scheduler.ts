import type { CronJob } from "bun";
import type { RunDispatcher } from "../run/dispatcher.js";
import type { RuntimeOpsStore } from "../runtime-ops/store.js";
import type { CronJobRow } from "./domain.js";
import type { CronJobService } from "./service.js";

export function createCronScheduler(deps: {
  cronSvc: CronJobService;
  dispatcher: RunDispatcher;
  supervisor: {
    cancel(runId: string): Promise<void> | void;
    onRunComplete(
      fn: (threadId: string, runId: string, status: string, kind: string) => void | Promise<void>,
    ): void;
  };
  opsStore: RuntimeOpsStore;
  buildSpec: (agentId: string, threadId: string, input: string) => Promise<Record<string, unknown>>;
  idGen: () => string;
  trace: () => { traceId: string; traceparent: string };
  now?: () => number;
}) {
  const handles = new Map<string, CronJob>();
  const watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  const retryCounts = new Map<string, number>();

  async function fire(job: CronJobRow, fireKey?: string): Promise<void> {
    const n = deps.now ?? Date.now;
    const key = fireKey ?? `${job.cronJobId}:${Math.floor(n() / 1000)}`;
    const attempt = retryCounts.get(key) ?? 0;
    const runId = deps.idGen();
    const threadId = `${job.cronJobId}:owner`;
    const t = deps.trace();
    const spec = await deps.buildSpec(job.agentId, threadId, job.prompt);

    await deps.dispatcher.dispatch({
      kind: "cron",
      runId,
      threadId,
      spec,
      opts: { trace: t },
      origin: {
        conversationId: job.cronJobId,
        sourceLedgerSeq: 0,
        agentMemberId: "owner",
        surface: "cron",
        traceId: t.traceId,
        traceparent: t.traceparent,
        idempotencyKey: `${key}:run:${attempt}`,
        issueId: null,
        fromStatus: "",
        cronJobId: job.cronJobId,
      },
    });

    if (job.timeoutMs > 0) {
      const wd = setTimeout(() => {
        void deps.supervisor.cancel(runId);
      }, job.timeoutMs);
      watchdogs.set(runId, wd);
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
      clearTimeout(wd);
      watchdogs.delete(runId);
    }

    // Only handle cron runs
    const origin = deps.opsStore.getRunOrigin(runId);
    if (origin?.originKind !== "cron" || !origin.cronJobId) return;

    // No retry on success
    if (status === "completed") return;

    const job = deps.cronSvc.port.getCronJob(origin.cronJobId);
    if (!job || job.maxRetries <= 0) return;

    const fireKey = origin.idempotencyKey.split(":run:")[0]!;
    const attempts = retryCounts.get(fireKey) ?? 0;
    if (attempts >= job.maxRetries) {
      retryCounts.delete(fireKey);
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
      for (const job of deps.cronSvc.port.listEnabledCronJobs()) this.register(job);
    },

    register(job: CronJobRow) {
      this.unregister(job.cronJobId);
      if (!job.enabled) return;
      handles.set(
        job.cronJobId,
        Bun.cron(job.cronExpr, () => {
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
    },

    dispose() {
      for (const h of handles.values()) h.stop();
      handles.clear();
      for (const wd of watchdogs.values()) clearTimeout(wd);
      watchdogs.clear();
      for (const t of retryTimers) clearTimeout(t);
      retryTimers.clear();
      retryCounts.clear();
    },
  };
}

export type CronScheduler = ReturnType<typeof createCronScheduler>;
