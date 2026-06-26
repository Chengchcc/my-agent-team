import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { RunSupervisor } from "./supervisor.js";

function makeDB(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  return db;
}

function makeSupervisor(db: Database): RunSupervisor {
  return new RunSupervisor({
    config: {
      dataDir: "/tmp",
      reaperIntervalMs: 0,
      heartbeatTimeoutMs: 30000,
      heartbeatIntervalMs: 5000,
      stepStallTimeoutMs: 120000,
      cancelGraceMs: 5000,
      port: 0,
      host: "",
      authToken: "",
      maxConcurrentRuns: 8,
      anthropicApiKey: "",
      shutdownTimeoutMs: 5000,
      workspaceRoot: "/tmp",
      templateDir: "/tmp",
    },
    eventLog: {
      append: async () => 1,
      read: () => Promise.resolve([] as never[]),
      subscribe: () => (async function* () {})() as AsyncIterable<any>,
    },
    opsStore: { appendRunEvent: () => {} } as unknown as any,
    tracer: {
      inject: () => ({ traceId: "", traceparent: "" }),
      startSpan: () => ({}),
      currentTrace: () => null,
      link: () => {},
    } as any,
    db,
  });
}

describe("RunSupervisor", () => {
  test("startMainRun creates run and attempt rows", async () => {
    const db = makeDB();
    const s = makeSupervisor(db);
    const { runId, attemptId } = await s.startMainRun("r1", "t1", { agentId: "a1" });
    expect(runId).toBe("r1");
    expect(attemptId).toBe("att-r1");
    const run = db.query("SELECT * FROM run WHERE run_id = ?").get("r1") as { status: string };
    expect(run.status).toBe("running");
    s.dispose();
  });

  test("cancel returns true for active run, false for missing", async () => {
    const db = makeDB();
    const s = makeSupervisor(db);
    await s.startMainRun("r1", "t1", { agentId: "a1" });
    expect(s.cancel("r1")).toBe(true);
    expect(s.cancel("gone")).toBe(false);
    s.dispose();
  });

  test("onRunComplete callback fires via notifyRunComplete", async () => {
    const db = makeDB();
    const s = makeSupervisor(db);
    const done: string[] = [];
    s.onRunComplete((_tid, _rid, status) => {
      done.push(status);
    });
    await s.notifyRunComplete("t1", "r1", "succeeded", "main", null);
    expect(done).toEqual(["succeeded"]);
    s.dispose();
  });
});
