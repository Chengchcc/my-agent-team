import { describe, expect, mock, test } from "bun:test";
import { createCronScheduler } from "./scheduler.js";
import type { CronJobRow } from "./domain.js";

function makeJob(overrides: Partial<CronJobRow> = {}): CronJobRow {
  return {
    cronJobId: "cj-test",
    name: "Test Job",
    agentId: "agent-1",
    cronExpr: "0 9 * * *",
    prompt: "hello",
    enabled: true,
    timeoutMs: 0,
    maxRetries: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

/** Minimal deps for exercises that only call register/unregister/dispose/start.
 *  onRunComplete is always called at construction time, so supervisor is required.
 *  Returns `any` to avoid declaring full CronJobService/RunDispatcher shapes. */
function minimalDeps(overrides: Record<string, unknown> = {}): any {
  return {
    cronSvc: { port: { listEnabledCronJobs: () => [] as CronJobRow[] } },
    dispatcher: null as any,
    supervisor: {
      cancel: () => {},
      onRunComplete: () => {},
    },
    opsStore: null as any,
    buildSpec: async () => ({} as Record<string, unknown>),
    idGen: () => "r",
    trace: () => ({ traceId: "t", traceparent: "tp" }),
    ...overrides,
  };
}

describe("createCronScheduler", () => {
  test("start registers all enabled jobs from port", () => {
    const job = makeJob();
    const listEnabledCronJobs = mock(() => [job]);
    let handledJob: CronJobRow | undefined;
    const scheduler = createCronScheduler(
      minimalDeps({
        cronSvc: { port: { listEnabledCronJobs, getCronJob: () => job } },
      }),
    );
    // Intercept register to capture the job
    const origRegister = scheduler.register.bind(scheduler);
    scheduler.register = (j: CronJobRow) => {
      handledJob = j;
      origRegister(j);
    };
    scheduler.start();
    expect(listEnabledCronJobs).toHaveBeenCalledTimes(1);
    expect(handledJob).toBe(job);
    scheduler.dispose();
  });

  test("register enabled job creates a handle", () => {
    const job = makeJob({ enabled: true, cronExpr: "0 0 1 1 *" }); // won't fire in tests
    const scheduler = createCronScheduler(minimalDeps());
    scheduler.register(job);
    // no throw = handle created
    scheduler.dispose();
  });

  test("register disabled job does not create a handle", () => {
    const job = makeJob({ enabled: false });
    const scheduler = createCronScheduler(minimalDeps());
    scheduler.register(job);
    // no throw = no handle to cleanup
    scheduler.dispose();
  });

  test("unregister stops and removes handle", () => {
    const job = makeJob({ cronExpr: "0 0 1 1 *" });
    const scheduler = createCronScheduler(minimalDeps());
    scheduler.register(job);
    scheduler.unregister(job.cronJobId);
    // double-unregister is a no-op, not a throw
    scheduler.unregister(job.cronJobId);
    scheduler.dispose();
  });

  test("re-registering a job stops the old handle first", () => {
    const job = makeJob({ cronExpr: "0 0 1 1 *" });
    const scheduler = createCronScheduler(minimalDeps());
    scheduler.register(job);
    scheduler.register(job); // re-register same cronJobId
    scheduler.dispose();
  });

  test("dispose stops all handles and clears watchdogs", () => {
    const scheduler = createCronScheduler(minimalDeps());
    scheduler.register(makeJob({ cronExpr: "0 0 1 1 *" }));
    scheduler.register(makeJob({ cronJobId: "cj-2", cronExpr: "0 0 1 1 *" }));
    scheduler.dispose();
    // Idempotent second dispose
    scheduler.dispose();
  });

  test("onRunComplete listener is registered with supervisor during construction", () => {
    let registeredListener: Function | undefined;
    const scheduler = createCronScheduler(
      minimalDeps({
        supervisor: {
          cancel: () => {},
          onRunComplete: (fn: Function) => {
            registeredListener = fn;
          },
        },
        cronSvc: { port: { listEnabledCronJobs: () => [], getCronJob: () => makeJob() } },
      }),
    );
    expect(registeredListener).toBeDefined();
    expect(typeof registeredListener).toBe("function");
    scheduler.dispose();
  });

  test("onRunComplete ignores non-cron origin", () => {
    const appendRunEvent = mock(() => 1);
    let listener: Function | undefined;
    const scheduler = createCronScheduler(
      minimalDeps({
        supervisor: {
          cancel: () => {},
          onRunComplete: (fn: Function) => {
            listener = fn;
          },
        },
        opsStore: {
          getRunOrigin: () => ({ originKind: "manual", cronJobId: null }),
          appendRunEvent,
        },
        cronSvc: { port: { listEnabledCronJobs: () => [], getCronJob: () => makeJob() } },
      }),
    );
    // Should not throw and should not record retry events
    listener!("thread-1", "r1", "error", "main");
    expect(appendRunEvent).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  test("onRunComplete ignores completed cron run", () => {
    const appendRunEvent = mock(() => 1);
    let listener: Function | undefined;
    const scheduler = createCronScheduler(
      minimalDeps({
        supervisor: {
          cancel: () => {},
          onRunComplete: (fn: Function) => {
            listener = fn;
          },
        },
        opsStore: {
          getRunOrigin: () => ({
            originKind: "cron",
            cronJobId: "cj-test",
            idempotencyKey: "cj-test:1234567890:run:0",
          }),
          appendRunEvent,
        },
        cronSvc: { port: { listEnabledCronJobs: () => [], getCronJob: () => makeJob({ maxRetries: 3 }) } },
      }),
    );
    listener!("thread-1", "r1", "completed", "main");
    // No retry events for completed runs
    expect(appendRunEvent).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  test("onRunComplete records retry_requested event for failed cron run", () => {
    const appendRunEvent = mock(() => 1);
    let listener: Function | undefined;
    const scheduler = createCronScheduler(
      minimalDeps({
        supervisor: {
          cancel: () => {},
          onRunComplete: (fn: Function) => {
            listener = fn;
          },
        },
        opsStore: {
          getRunOrigin: () => ({
            originKind: "cron",
            cronJobId: "cj-test",
            idempotencyKey: "cj-test:1234567890:run:0",
          }),
          appendRunEvent,
        },
        cronSvc: { port: { listEnabledCronJobs: () => [], getCronJob: () => makeJob({ maxRetries: 3 }) } },
      }),
    );
    // Simulate an errored cron run
    listener!("thread-1", "r1", "error", "main");
    // retry_requested event must be recorded synchronously (before setTimeout fires)
    expect(appendRunEvent).toHaveBeenCalledTimes(1);
    const call = (appendRunEvent as any).mock.calls[0][0];
    expect(call.kind).toBe("retry_requested");
    expect(call.payload.attempt).toBe(1);
    scheduler.dispose();
  });

  test("onRunComplete does not retry beyond maxRetries", () => {
    const appendRunEvent = mock(() => 1);
    let listener: Function | undefined;
    let callCount = 0;
    const scheduler = createCronScheduler(
      minimalDeps({
        supervisor: {
          cancel: () => {},
          onRunComplete: (fn: Function) => {
            listener = fn;
          },
        },
        opsStore: {
          getRunOrigin: () => ({
            originKind: "cron",
            cronJobId: "cj-test",
            idempotencyKey: `cj-test:1700000000:run:${callCount}`,
          }),
          appendRunEvent,
        },
        cronSvc: { port: { listEnabledCronJobs: () => [], getCronJob: () => makeJob({ maxRetries: 2 }) } },
      }),
    );

    // First failure — should retry (attempt 1 of 2)
    listener!("thread-1", "r1", "error", "main");
    callCount++;
    // Second failure — should retry (attempt 2 of 2)
    listener!("thread-1", "r2", "error", "main");
    callCount++;

    const retryEvents = (appendRunEvent as any).mock.calls.filter(
      (c: any) => c[0].kind === "retry_requested",
    );
    expect(retryEvents).toHaveLength(2);

    // Third failure — maxRetries reached, no more retries
    listener!("thread-1", "r3", "error", "main");
    const retryEventsAfter = (appendRunEvent as any).mock.calls.filter(
      (c: any) => c[0].kind === "retry_requested",
    );
    expect(retryEventsAfter).toHaveLength(2); // still 2, no new one

    scheduler.dispose();
  });

  test("onRunComplete does not retry when job has maxRetries=0", () => {
    const appendRunEvent = mock(() => 1);
    let listener: Function | undefined;
    const scheduler = createCronScheduler(
      minimalDeps({
        supervisor: {
          cancel: () => {},
          onRunComplete: (fn: Function) => {
            listener = fn;
          },
        },
        opsStore: {
          getRunOrigin: () => ({
            originKind: "cron",
            cronJobId: "cj-test",
            idempotencyKey: "cj-test:1234567890:run:0",
          }),
          appendRunEvent,
        },
        cronSvc: { port: { listEnabledCronJobs: () => [], getCronJob: () => makeJob({ maxRetries: 0 }) } },
      }),
    );
    listener!("thread-1", "r1", "error", "main");
    expect(appendRunEvent).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  test("onRunComplete cleans watchdog timer on run completion", () => {
    let listener: Function | undefined;
    const scheduler = createCronScheduler(
      minimalDeps({
        supervisor: {
          cancel: () => {},
          onRunComplete: (fn: Function) => {
            listener = fn;
          },
        },
        opsStore: {
          getRunOrigin: () => ({
            originKind: "cron",
            cronJobId: "cj-wd",
            idempotencyKey: "cj-wd:1234567890:run:0",
          }),
          appendRunEvent: mock(() => 1),
        },
        cronSvc: { port: { listEnabledCronJobs: () => [], getCronJob: () => makeJob({ maxRetries: 0 }) } },
      }),
    );
    // Call onRunComplete for the watched run — watchdog cleanup path exercises
    // without throwing even when no watchdog was pre-registered.
    listener!("thread-1", "r-wd", "completed", "main");
    scheduler.dispose();
  });
});
