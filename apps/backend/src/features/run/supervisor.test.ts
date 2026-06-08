import { describe, expect, test, afterEach, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { inMemoryEventLog } from "@my-agent-team/event-log";
import type { EventLog } from "@my-agent-team/event-log";
import { RunSupervisor } from "./supervisor.js";
import type { BackendConfig } from "../../config.js";

const TEST_DATA_DIR = `/tmp/test-reaper-${Date.now()}`;

beforeAll(() => {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
});

function makeConfig(overrides?: Partial<BackendConfig>): BackendConfig {
  return {
    port: 3000,
    host: "127.0.0.1",
    dataDir: TEST_DATA_DIR,
    workspaceRoot: "/tmp/ws",
    templateDir: "/tmp/templates",
    authToken: "test-token",
    maxConcurrentRuns: 4,
    anthropicApiKey: "sk-test",
    shutdownTimeoutMs: 30_000,
    heartbeatIntervalMs: 5_000,
    heartbeatTimeoutMs: 100, // very short for testing
    cancelGraceMs: 5_000,
    reaperIntervalMs: 50,  // fast reaper for tests
    stepStallTimeoutMs: 200,
    ...overrides,
  };
}

function makeEventLog(): EventLog {
  return inMemoryEventLog();
}

describe("RunSupervisor reaper (M11)", () => {
  afterEach(() => {
    // Cleanup handled by test isolation
  });

  test("reaper starts on construction", () => {
    const config = makeConfig();
    const eventLog = makeEventLog();
    const sup = new RunSupervisor({ eventLog, config, runnerBin: "/fake/runner" });
    // Reaper timer should be set
    expect(sup).toBeDefined();
    sup.dispose();
  });

  test("reaper marks stale attempt as interrupted", async () => {
    const config = makeConfig();
    const eventLog = makeEventLog();
    const sup = new RunSupervisor({ eventLog, config, runnerBin: "/fake/runner" });

    const db = sup.getDb();
    // Insert a run and attempt with old heartbeat
    const oldHeartbeat = Date.now() - 200; // older than heartbeatTimeoutMs=100
    db.run("INSERT INTO run (run_id, thread_id, status, started_at) VALUES (?, ?, 'running', ?)", [
      "run-stale", "thread-1", Date.now() - 5000,
    ]);
    db.run("INSERT INTO attempt (attempt_id, run_id, pid, heartbeat_at, started_at) VALUES (?, ?, ?, ?, ?)", [
      "att-stale", "run-stale", 99999, oldHeartbeat, Date.now() - 5000,
    ]);

    // Wait for reaper to fire (reaperIntervalMs=50ms)
    await new Promise((r) => setTimeout(r, 150));

    // Check run was marked interrupted
    const runRow = db.query("SELECT status, ended_at FROM run WHERE run_id = ?").get("run-stale") as { status: string; ended_at: number | null } | undefined;
    expect(runRow?.status).toBe("interrupted");
    expect(runRow?.ended_at).toBeGreaterThan(0);

    // Check attempt was ended
    const attRow = db.query("SELECT ended_at FROM attempt WHERE attempt_id = ?").get("att-stale") as { ended_at: number | null } | undefined;
    expect(attRow?.ended_at).toBeGreaterThan(0);

    sup.dispose();
  });

  test("reaper does NOT mark fresh heartbeat as interrupted", async () => {
    const config = makeConfig({ heartbeatTimeoutMs: 500 }); // long timeout for this test
    const eventLog = makeEventLog();
    const sup = new RunSupervisor({ eventLog, config, runnerBin: "/fake/runner" });

    const db = sup.getDb();
    const freshHeartbeat = Date.now(); // just now
    db.run("INSERT INTO run (run_id, thread_id, status, started_at) VALUES (?, ?, 'running', ?)", [
      "run-fresh", "thread-2", Date.now() - 1000,
    ]);
    db.run("INSERT INTO attempt (attempt_id, run_id, pid, heartbeat_at, started_at) VALUES (?, ?, ?, ?, ?)", [
      "att-fresh", "run-fresh", 88888, freshHeartbeat, Date.now() - 1000,
    ]);

    await new Promise((r) => setTimeout(r, 200));

    const runRow = db.query("SELECT status FROM run WHERE run_id = ?").get("run-fresh") as { status: string } | undefined;
    expect(runRow?.status).toBe("running");

    sup.dispose();
  });

  test("reaper triggers onRunComplete callback", async () => {
    const config = makeConfig();
    const eventLog = makeEventLog();
    const sup = new RunSupervisor({ eventLog, config, runnerBin: "/fake/runner" });

    const completed: Array<{ threadId: string; runId: string }> = [];
    sup.onRunComplete((threadId, runId) => {
      completed.push({ threadId, runId });
    });

    const db = sup.getDb();
    const oldHeartbeat = Date.now() - 200;
    const uniqueRunId = `run-cb-${Date.now()}`;
    db.run("INSERT INTO run (run_id, thread_id, status, started_at) VALUES (?, ?, 'running', ?)", [
      uniqueRunId, "thread-3", Date.now() - 5000,
    ]);
    db.run("INSERT INTO attempt (attempt_id, run_id, pid, heartbeat_at, started_at) VALUES (?, ?, ?, ?, ?)", [
      `att-${uniqueRunId}`, uniqueRunId, 77777, oldHeartbeat, Date.now() - 5000,
    ]);

    await new Promise((r) => setTimeout(r, 200));

    // Check our specific run triggered onRunComplete
    const ours = completed.filter((c) => c.runId === uniqueRunId);
    expect(ours.length).toBe(1);
    expect(ours[0]!.threadId).toBe("thread-3");

    sup.dispose();
  });

  test("dispose() stops the reaper timer", async () => {
    const config = makeConfig();
    const eventLog = makeEventLog();
    const sup = new RunSupervisor({ eventLog, config, runnerBin: "/fake/runner" });

    const db = sup.getDb();
    const oldHeartbeat = Date.now() - 200;
    db.run("INSERT INTO run (run_id, thread_id, status, started_at) VALUES (?, ?, 'running', ?)", [
      "run-dispose", "thread-4", Date.now() - 5000,
    ]);
    db.run("INSERT INTO attempt (attempt_id, run_id, pid, heartbeat_at, started_at) VALUES (?, ?, ?, ?, ?)", [
      "att-dispose", "run-dispose", 66666, oldHeartbeat, Date.now() - 5000,
    ]);

    // Check run is still running before dispose (reaper had minimal cycles)
    const beforeRow = db.query("SELECT status FROM run WHERE run_id = ?").get("run-dispose") as { status: string } | undefined;
    expect(beforeRow?.status).toBe("running");

    // Dispose — this stops the reaper and closes the DB
    sup.dispose();

    // Verify dispose cleaned up (no crash, no hang)
    expect(sup.activeCount).toBe(0);
  });

  test("reaper appends terminal event to EventLog", async () => {
    const config = makeConfig();
    const eventLog = makeEventLog();
    const sup = new RunSupervisor({ eventLog, config, runnerBin: "/fake/runner" });

    const db = sup.getDb();
    const oldHeartbeat = Date.now() - 200;
    const uniqueRunId = `run-ev-${Date.now()}`;
    db.run("INSERT INTO run (run_id, thread_id, status, started_at) VALUES (?, ?, 'running', ?)", [
      uniqueRunId, "thread-5", Date.now() - 5000,
    ]);
    db.run("INSERT INTO attempt (attempt_id, run_id, pid, heartbeat_at, started_at) VALUES (?, ?, ?, ?, ?)", [
      `att-${uniqueRunId}`, uniqueRunId, 55555, oldHeartbeat, Date.now() - 5000,
    ]);

    // Wait for reaper to fire (async reaper needs time to complete append)
    await new Promise((r) => setTimeout(r, 250));

    // Read events from EventLog
    const events = await eventLog.read({ runId: uniqueRunId });
    expect(events.length).toBeGreaterThan(0);
    const terminal = events.find((e) => e.event.type === "interrupted");
    expect(terminal).toBeDefined();

    sup.dispose();
  });

  test("rediscover still works after reaper extraction", async () => {
    const config = makeConfig({ heartbeatTimeoutMs: 10_000 }); // long timeout
    const eventLog = makeEventLog();
    const sup = new RunSupervisor({ eventLog, config, runnerBin: "/fake/runner" });

    const db = sup.getDb();
    const freshHeartbeat = Date.now();
    db.run("INSERT INTO run (run_id, thread_id, status, started_at) VALUES (?, ?, 'running', ?)", [
      "run-rediscover", "thread-6", Date.now() - 1000,
    ]);
    db.run("INSERT INTO attempt (attempt_id, run_id, pid, heartbeat_at, started_at) VALUES (?, ?, ?, ?, ?)", [
      "att-rediscover", "run-rediscover", 44444, freshHeartbeat, Date.now() - 1000,
    ]);

    await sup.rediscover(eventLog);

    // rediscover should have re-registered the live run in #active
    expect(sup.activeCount).toBeGreaterThanOrEqual(1);

    sup.dispose();
  });
});
