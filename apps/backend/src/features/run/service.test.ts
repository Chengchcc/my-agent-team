import { describe, expect, test } from "bun:test";
import type { EventLog } from "@my-agent-team/event-log";
import {
  createRunService,
  RunNotFoundError,
  ThreadBusyError,
  TooManyRunsError,
} from "./service.js";
import type { RunSupervisor } from "./supervisor.js";

function makeMockSupervisor(overrides?: Partial<RunSupervisor>): RunSupervisor {
  return {
    activeCount: 0,
    fork: () => ({ runId: "run-1", attemptId: "att-1", pid: 12345 }),
    cancel: () => true,
    rediscover: async () => {},
    onRunComplete: () => {},
    dispose: () => {},
    cancelByPid: () => true,
    getDb: () =>
      ({
        query: () => ({ get: () => null as unknown }),
      }) as any,
    ...overrides,
  } as unknown as RunSupervisor;
}

function makeMockEventLog(): EventLog {
  return {
    append: async () => 1,
    read: async () => [],
    subscribe: () => (async function* () {})() as AsyncIterable<any>,
  };
}

describe("RunService", () => {
  test("start returns { runId, attemptId }", () => {
    const svc = createRunService({
      supervisor: makeMockSupervisor(),
      eventLog: makeMockEventLog(),
      maxConcurrentRuns: 8,
      threads: new Set(),
      idGen: () => "run-1",
    });

    const result = svc.start("th-1", "hello", "{}");
    expect(result.runId).toBe("run-1");
    expect(result.attemptId).toBe("att-1");
  });

  test("start throws ThreadBusyError when thread already running", () => {
    const threads = new Set<string>(["th-1"]);
    const svc = createRunService({
      supervisor: makeMockSupervisor(),
      eventLog: makeMockEventLog(),
      maxConcurrentRuns: 8,
      threads,
      idGen: () => "run-1",
    });

    expect(() => svc.start("th-1", "hi", "{}")).toThrow(ThreadBusyError);
  });

  test("start throws TooManyRunsError when at capacity", () => {
    const svc = createRunService({
      supervisor: makeMockSupervisor({ activeCount: 8 }),
      eventLog: makeMockEventLog(),
      maxConcurrentRuns: 8,
      threads: new Set(),
      idGen: () => "run-1",
    });

    expect(() => svc.start("th-1", "hi", "{}")).toThrow(TooManyRunsError);
  });

  test("cancel delegates to supervisor", () => {
    let cancelled = false;
    const svc = createRunService({
      supervisor: makeMockSupervisor({
        cancel: () => {
          cancelled = true;
          return true;
        },
      }),
      eventLog: makeMockEventLog(),
      maxConcurrentRuns: 8,
      threads: new Set(),
      idGen: () => "run-1",
    });

    svc.cancel("run-1");
    expect(cancelled).toBe(true);
  });

  test("cancel throws RunNotFoundError for unknown runId", () => {
    const svc = createRunService({
      supervisor: makeMockSupervisor({ cancel: () => false }),
      eventLog: makeMockEventLog(),
      maxConcurrentRuns: 8,
      threads: new Set(),
      idGen: () => "run-1",
    });

    expect(() => svc.cancel("nonexistent")).toThrow(RunNotFoundError);
  });

  test("eventStream delegates to EventLog.subscribe", async () => {
    const mockLog = {
      ...makeMockEventLog(),
      subscribe: async function* () {
        yield {
          seq: 1,
          threadId: "t1",
          runId: "r1",
          event: { type: "message", message: { role: "assistant", content: "hi" } },
          ts: 1,
        };
      },
    } as EventLog;

    const svc = createRunService({
      supervisor: makeMockSupervisor(),
      eventLog: mockLog,
      maxConcurrentRuns: 8,
      threads: new Set(),
      idGen: () => "run-1",
    });

    const collected: any[] = [];
    for await (const rec of svc.eventStream("r1")) {
      collected.push(rec);
    }
    expect(collected.length).toBe(1);
    expect(collected[0]?.seq).toBe(1);
  });
});
