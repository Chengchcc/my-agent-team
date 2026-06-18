import { describe, expect, test } from "bun:test";
import { ConversationLock } from "../conversation/lock.js";
import type { EventLog, EventRecord } from "../event-log/index.js";
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
    startMainRun: async () => ({ runId: "run-1", attemptId: "att-1" }),
    cancel: () => true,
    rediscover: async () => {},
    onRunComplete: () => {},
    dispose: () => {},
    cancelByPid: () => true,
    getDb: () => ({
      query: () => ({ get: () => null as unknown }),
    }),
    ...overrides,
  } as unknown as RunSupervisor;
}

function makeMockEventLog(): EventLog {
  return {
    append: async () => 1,
    read: async () => [],
    subscribe: () => (async function* () {})() as AsyncIterable<EventRecord>,
  };
}

describe("RunService", () => {
  test("start returns { runId, attemptId }", async () => {
    const svc = createRunService({
      supervisor: makeMockSupervisor(),
      eventLog: makeMockEventLog(),
      maxConcurrentRuns: 8,
      lock: new ConversationLock(),
      idGen: () => "run-1",
    });

    const result = await svc.start("th-1", { agentId: "agent-1" });
    expect(result.runId).toBe("run-1");
    expect(result.attemptId).toBe("att-1");
  });

  test("start throws ThreadBusyError when thread already running", () => {
    const lock = new ConversationLock();
    lock.acquireThread("th-1", "th-1");
    const svc = createRunService({
      supervisor: makeMockSupervisor(),
      eventLog: makeMockEventLog(),
      maxConcurrentRuns: 8,
      lock,
      idGen: () => "run-1",
    });

    expect(() => svc.start("th-1", {})).toThrow(ThreadBusyError);
  });

  test("start throws TooManyRunsError when at capacity", () => {
    const svc = createRunService({
      supervisor: makeMockSupervisor({ activeCount: 8 }),
      eventLog: makeMockEventLog(),
      maxConcurrentRuns: 8,
      lock: new ConversationLock(),
      idGen: () => "run-1",
    });

    expect(() => svc.start("th-1", {})).toThrow(TooManyRunsError);
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
      lock: new ConversationLock(),
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
      lock: new ConversationLock(),
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
      lock: new ConversationLock(),
      idGen: () => "run-1",
    });

    const collected: EventRecord[] = [];
    for await (const rec of svc.eventStream("r1")) {
      collected.push(rec);
    }
    expect(collected.length).toBe(1);
    expect(collected[0]?.seq).toBe(1);
  });
});
