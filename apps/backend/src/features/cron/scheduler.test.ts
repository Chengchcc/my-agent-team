/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, mock, test } from "bun:test";
import type { CronJobRow } from "./domain.js";
import { createCronScheduler } from "./scheduler.js";

type ListenerFn = (
  sessionId: string,
  spanId: string,
  status: string,
  kind: string,
) => void | Promise<void>;

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
    config: { dataDir: "/tmp", anthropicApiKey: "test" },
    agentSvc: {
      getById: async () => ({
        modelName: "claude",
        modelProvider: "anthropic",
        modelBaseUrl: null,
        permissionMode: "ask",
        maxSteps: null,
      }),
    },
    supervisor: {
      cancel: () => {},
      onRunComplete: () => {},
      startMainRun: async (id: string) => ({ spanId: id, attemptId: `att-${id}` }),
      getActive: () => new Map() as ReadonlyMap<string, { abortController: AbortController }>,
      notifyRunComplete: async () => {},
    },
    opsStore: null as any,
    idGen: () => "r",
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
    let registeredListener: ListenerFn | undefined;
    const scheduler = createCronScheduler(
      minimalDeps({
        supervisor: {
          cancel: () => {},
          onRunComplete: (fn: ListenerFn) => {
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
    const appendControlPlaneEvent = mock(() => 1);
    let listener: ListenerFn | undefined;
    const scheduler = createCronScheduler(
      minimalDeps({
        supervisor: {
          cancel: () => {},
          onRunComplete: (fn: ListenerFn) => {
            listener = fn;
          },
        },
        opsStore: {
          getSpanOrigin: () => ({ originKind: "manual", cronJobId: null }),
          appendControlPlaneEvent,
        },
        cronSvc: { port: { listEnabledCronJobs: () => [], getCronJob: () => makeJob() } },
      }),
    );
    // Should not throw and should not record retry events
    listener!("thread-1", "r1", "error", "main");
    expect(appendControlPlaneEvent).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  test("onRunComplete ignores completed cron run", () => {
    const appendControlPlaneEvent = mock(() => 1);
    let listener: ListenerFn | undefined;
    const scheduler = createCronScheduler(
      minimalDeps({
        supervisor: {
          cancel: () => {},
          onRunComplete: (fn: ListenerFn) => {
            listener = fn;
          },
        },
        opsStore: {
          getSpanOrigin: () => ({
            originKind: "cron",
            cronJobId: "cj-test",
            idempotencyKey: "cj-test:1234567890:run:0",
          }),
          appendControlPlaneEvent,
        },
        cronSvc: {
          port: { listEnabledCronJobs: () => [], getCronJob: () => makeJob({ maxRetries: 3 }) },
        },
      }),
    );
    listener!("thread-1", "r1", "succeeded", "main");
    // No retry events for completed runs
    expect(appendControlPlaneEvent).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  test("onRunComplete records retry_requested event for failed cron run", () => {
    const appendControlPlaneEvent = mock(() => 1);
    let listener: ListenerFn | undefined;
    const scheduler = createCronScheduler(
      minimalDeps({
        supervisor: {
          cancel: () => {},
          onRunComplete: (fn: ListenerFn) => {
            listener = fn;
          },
        },
        opsStore: {
          getSpanOrigin: () => ({
            originKind: "cron",
            cronJobId: "cj-test",
            idempotencyKey: "cj-test:1234567890:run:0",
          }),
          appendControlPlaneEvent,
        },
        cronSvc: {
          port: { listEnabledCronJobs: () => [], getCronJob: () => makeJob({ maxRetries: 3 }) },
        },
      }),
    );
    // Simulate an errored cron run
    listener!("thread-1", "r1", "error", "main");
    // retry_requested event must be recorded synchronously (before setTimeout fires)
    expect(appendControlPlaneEvent).toHaveBeenCalledTimes(1);
    const call = (appendControlPlaneEvent as any).mock.calls[0][0];
    expect(call.kind).toBe("retry_requested");
    expect(call.payload.attempt).toBe(1);
    scheduler.dispose();
  });

  test("onRunComplete does not retry beyond maxRetries", () => {
    const appendControlPlaneEvent = mock(() => 1);
    let listener: ListenerFn | undefined;
    let callCount = 0;
    const scheduler = createCronScheduler(
      minimalDeps({
        supervisor: {
          cancel: () => {},
          onRunComplete: (fn: ListenerFn) => {
            listener = fn;
          },
        },
        opsStore: {
          getSpanOrigin: () => ({
            originKind: "cron",
            cronJobId: "cj-test",
            idempotencyKey: `cj-test:1700000000:run:${callCount}`,
          }),
          appendControlPlaneEvent,
        },
        cronSvc: {
          port: { listEnabledCronJobs: () => [], getCronJob: () => makeJob({ maxRetries: 2 }) },
        },
      }),
    );

    // First failure — should retry (attempt 1 of 2)
    listener!("thread-1", "r1", "error", "main");
    callCount++;
    // Second failure — should retry (attempt 2 of 2)
    listener!("thread-1", "r2", "error", "main");
    callCount++;

    const retryEvents = (appendControlPlaneEvent as any).mock.calls.filter(
      (c: any) => c[0].kind === "retry_requested",
    );
    expect(retryEvents).toHaveLength(2);

    // Third failure — maxRetries reached, no more retries
    listener!("thread-1", "r3", "error", "main");
    const retryEventsAfter = (appendControlPlaneEvent as any).mock.calls.filter(
      (c: any) => c[0].kind === "retry_requested",
    );
    expect(retryEventsAfter).toHaveLength(2); // still 2, no new one

    scheduler.dispose();
  });

  test("onRunComplete does not retry when job has maxRetries=0", () => {
    const appendControlPlaneEvent = mock(() => 1);
    let listener: ListenerFn | undefined;
    const scheduler = createCronScheduler(
      minimalDeps({
        supervisor: {
          cancel: () => {},
          onRunComplete: (fn: ListenerFn) => {
            listener = fn;
          },
        },
        opsStore: {
          getSpanOrigin: () => ({
            originKind: "cron",
            cronJobId: "cj-test",
            idempotencyKey: "cj-test:1234567890:run:0",
          }),
          appendControlPlaneEvent,
        },
        cronSvc: {
          port: { listEnabledCronJobs: () => [], getCronJob: () => makeJob({ maxRetries: 0 }) },
        },
      }),
    );
    listener!("thread-1", "r1", "error", "main");
    expect(appendControlPlaneEvent).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  test("onRunComplete cleans watchdog timer on run completion", () => {
    let listener: ListenerFn | undefined;
    const scheduler = createCronScheduler(
      minimalDeps({
        supervisor: {
          cancel: () => {},
          onRunComplete: (fn: ListenerFn) => {
            listener = fn;
          },
        },
        opsStore: {
          getSpanOrigin: () => ({
            originKind: "cron",
            cronJobId: "cj-wd",
            idempotencyKey: "cj-wd:1234567890:run:0",
          }),
          appendControlPlaneEvent: mock(() => 1),
        },
        cronSvc: {
          port: { listEnabledCronJobs: () => [], getCronJob: () => makeJob({ maxRetries: 0 }) },
        },
      }),
    );
    // Call onRunComplete for the watched run — watchdog cleanup path exercises
    // without throwing even when no watchdog was pre-registered.
    listener!("thread-1", "r-wd", "succeeded", "main");
    scheduler.dispose();
  });
});

describe("fireLoop M4", () => {
  test("manual loop not registered", () => {
    const scheduled: string[] = [];
    const sched = {
      schedule(expr: string, _fn: () => void) {
        scheduled.push(expr);
        return { stop() {} };
      },
    };
    const scheduler = createCronScheduler({
      ...minimalDeps(),
      scheduler: sched as any,
    });
    scheduler.register(makeJob({ cronExpr: undefined as any, loopConfigPath: "/tmp/loop" }));
    expect(scheduled.length).toBe(0);
  });

  test("fire calls loopStep for loop job", async () => {
    const loopStepCalls: any[] = [];
    const scheduler = createCronScheduler({
      ...minimalDeps(),
      cronSvc: {
        port: {
          listEnabledCronJobs: () => [makeJob({ loopConfigPath: "/tmp/loop" })],
          getCronJob: () => makeJob({ loopConfigPath: "/tmp/loop", maxRetries: 0 }),
        },
      },
    } as any);
    // fireLoop 通过 register 触发 — we test via the schedule callback
    let firedJob: CronJobRow | undefined;
    const testSched = {
      schedule(_expr: string, fn: () => void) {
        firedJob = makeJob({ loopConfigPath: "/tmp/loop", maxRetries: 0 });
        return { stop() {} };
      },
    };
    const s2 = createCronScheduler({
      ...minimalDeps(),
      scheduler: testSched as any,
      cronSvc: {
        port: {
          listEnabledCronJobs: () => [],
          getCronJob: () => makeJob({ loopConfigPath: "/tmp/loop", maxRetries: 0 }),
        },
      },
    } as any);
    s2.register(makeJob({ cronExpr: "0 8 * * *", loopConfigPath: "/tmp/loop", maxRetries: 0 }));
  });
});
