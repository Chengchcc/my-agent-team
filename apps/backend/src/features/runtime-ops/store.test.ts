import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RuntimeOpsStore } from "./store.js";
import { computeRunnerStatus } from "./types.js";

function createTestDb() {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  // Run events_db migrations inline for test isolation
  db.exec(`
    CREATE TABLE IF NOT EXISTS run (
      run_id     TEXT PRIMARY KEY,
      thread_id  TEXT NOT NULL,
      agent_id   TEXT NOT NULL DEFAULT '',
      status     TEXT NOT NULL DEFAULT 'running',
      kind       TEXT NOT NULL DEFAULT 'main',
      parent_run_id TEXT,
      started_at INTEGER NOT NULL,
      ended_at   INTEGER
    );
    CREATE TABLE IF NOT EXISTS run_ops_event (
      seq          INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id       TEXT NOT NULL,
      attempt_id   TEXT,
      kind         TEXT NOT NULL,
      payload      TEXT NOT NULL DEFAULT '{}',
      trace_id     TEXT,
      ts           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_run_ops_event_run ON run_ops_event(run_id, seq);
    CREATE TABLE IF NOT EXISTS run_origin (
      run_id            TEXT PRIMARY KEY,
      conversation_id   TEXT NOT NULL,
      source_ledger_seq INTEGER NOT NULL,
      agent_member_id   TEXT NOT NULL,
      surface           TEXT NOT NULL DEFAULT 'web',
      trace_id          TEXT NOT NULL,
      traceparent       TEXT NOT NULL,
      idempotency_key   TEXT NOT NULL,
      issue_id          TEXT,
      from_status       TEXT NOT NULL DEFAULT '',
      created_at        INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_run_origin_idem ON run_origin(idempotency_key);
    CREATE TABLE IF NOT EXISTS runner_health (
      agent_id          TEXT PRIMARY KEY,
      last_seen_at      INTEGER,
      uptime_ms         INTEGER,
      active_run_count  INTEGER NOT NULL DEFAULT 0,
      active_run_ids    TEXT NOT NULL DEFAULT '[]',
      checkpointer_ok   INTEGER NOT NULL DEFAULT 1,
      workspace_ok      INTEGER NOT NULL DEFAULT 1,
      last_error        TEXT,
      updated_at        INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS surface_health (
      agent_id       TEXT NOT NULL,
      surface        TEXT NOT NULL,
      status         TEXT NOT NULL,
      last_seen_at   INTEGER,
      payload        TEXT NOT NULL DEFAULT '{}',
      last_error     TEXT,
      updated_at     INTEGER NOT NULL,
      PRIMARY KEY (agent_id, surface)
    );
  `);
  return db;
}

describe("RuntimeOpsStore", () => {
  let db: Database;
  let store: RuntimeOpsStore;

  beforeEach(() => {
    db = createTestDb();
    store = new RuntimeOpsStore(db);
  });

  afterEach(() => db.close());

  describe("run_ops_event", () => {
    test("appendRunEvent and getRunEvents round-trip", () => {
      store.appendRunEvent({
        runId: "r1",
        attemptId: "a1",
        kind: "attempt_started",
        traceId: "trace-abc",
        payload: { mode: "run" },
      });

      const events = store.getRunEvents("r1");
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe("attempt_started");
      expect(events[0]!.runId).toBe("r1");
      expect(events[0]!.attemptId).toBe("a1");
      expect(events[0]!.traceId).toBe("trace-abc");
    });

    test("getRunEvents returns events ordered by seq", () => {
      store.appendRunEvent({ runId: "r1", kind: "attempt_started" });
      store.appendRunEvent({ runId: "r1", kind: "run_done_received" });
      store.appendRunEvent({ runId: "r1", kind: "run_finalized_sent" });

      const events = store.getRunEvents("r1");
      expect(events).toHaveLength(3);
      expect(events[0]!.kind).toBe("attempt_started");
      expect(events[2]!.kind).toBe("run_finalized_sent");
    });

    test("getRunEventsByTrace filters correctly", () => {
      store.appendRunEvent({ runId: "r1", kind: "attempt_started", traceId: "t1" });
      store.appendRunEvent({ runId: "r2", kind: "attempt_started", traceId: "t1" });
      store.appendRunEvent({ runId: "r3", kind: "attempt_started", traceId: "t2" });

      expect(store.getRunEventsByTrace("t1")).toHaveLength(2);
      expect(store.getRunEventsByTrace("t2")).toHaveLength(1);
    });

    test("appendRunEvent without optional fields", () => {
      store.appendRunEvent({ runId: "r1", kind: "reaper_marked_interrupted" });
      const events = store.getRunEvents("r1");
      expect(events).toHaveLength(1);
      expect(events[0]!.attemptId).toBeNull();
      expect(events[0]!.traceId).toBeNull();
    });
  });

  describe("run_origin", () => {
    test("insert and get by runId", () => {
      store.insertRunOrigin({
        runId: "r1",
        conversationId: "c1",
        sourceLedgerSeq: 5,
        agentMemberId: "agent:x",
        surface: "web",
        traceId: "t1",
        traceparent: "00-t1-s1-01",
        idempotencyKey: "ik-1",
        fromStatus: "",
        createdAt: 1000,
      });

      const row = store.getRunOrigin("r1");
      expect(row).not.toBeNull();
      expect(row!.conversationId).toBe("c1");
      expect(row!.sourceLedgerSeq).toBe(5);
    });

    test("getRunOriginByIdempotencyKey", () => {
      store.insertRunOrigin({
        runId: "r1",
        conversationId: "c1",
        sourceLedgerSeq: 5,
        agentMemberId: "agent:x",
        surface: "web",
        traceId: "t1",
        traceparent: "00-t1-s1-01",
        idempotencyKey: "ik-1",
        fromStatus: "",
        createdAt: 1000,
      });

      const row = store.getRunOriginByIdempotencyKey("ik-1");
      expect(row).not.toBeNull();
      expect(row!.runId).toBe("r1");
    });

    test("idempotent on duplicate idempotencyKey (INSERT OR IGNORE)", () => {
      const row = {
        runId: "r1",
        conversationId: "c1",
        sourceLedgerSeq: 5,
        agentMemberId: "agent:x",
        surface: "web" as const,
        traceId: "t1",
        traceparent: "00-t1-s1-01",
        idempotencyKey: "ik-dup",
        fromStatus: "",
        createdAt: 1000,
      };
      store.insertRunOrigin(row);
      // Second insert with same idempotencyKey should be silently ignored
      expect(() => store.insertRunOrigin({ ...row, runId: "r2" })).not.toThrow();
      // The original row is still there
      const origin = store.getRunOriginByIdempotencyKey("ik-dup");
      expect(origin!.runId).toBe("r1");
    });

    test("getRunOrigin returns null for missing run", () => {
      expect(store.getRunOrigin("nonexistent")).toBeNull();
    });
  });

  describe("runner_health", () => {
    test("upsert and get", () => {
      store.upsertRunnerHealth({
        agentId: "agent_x",
        uptimeMs: 5000,
        activeRunIds: ["r1"],
        checkpointerOk: true,
        workspaceOk: true,
      });

      const health = store.getRunnerHealth("agent_x");
      expect(health).toBeDefined();
      expect(health!.activeRunCount).toBe(1);
      expect(health!.checkpointerOk).toBe(1);
    });

    test("upsert updates existing row", () => {
      store.upsertRunnerHealth({
        agentId: "agent_x",
        uptimeMs: 5000,
        activeRunIds: ["r1"],
        checkpointerOk: true,
        workspaceOk: true,
      });
      store.upsertRunnerHealth({
        agentId: "agent_x",
        uptimeMs: 10000,
        activeRunIds: ["r1", "r2"],
        checkpointerOk: false,
        workspaceOk: true,
        lastError: "db fail",
      });

      const health = store.getRunnerHealth("agent_x");
      expect(health!.activeRunCount).toBe(2);
      expect(health!.checkpointerOk).toBe(0);
      expect(health!.lastError).toBe("db fail");
    });

    test("listRunnerHealths", () => {
      store.upsertRunnerHealth({
        agentId: "agent_a",
        uptimeMs: 5000,
        activeRunIds: [],
        checkpointerOk: true,
        workspaceOk: true,
      });
      store.upsertRunnerHealth({
        agentId: "agent_b",
        uptimeMs: 10000,
        activeRunIds: ["r1"],
        checkpointerOk: true,
        workspaceOk: true,
      });

      expect(store.listRunnerHealths()).toHaveLength(2);
    });
  });

  describe("surface_health", () => {
    test("upsert and get", () => {
      store.upsertSurfaceHealth({
        agentId: "agent_x",
        surface: "lark",
        status: "running",
        payload: { watchers: { conversation: 3 } },
      });

      const health = store.getSurfaceHealth("agent_x", "lark");
      expect(health).toBeDefined();
      expect(health!.status).toBe("running");
    });

    test("getSurfaceHealthsForAgent", () => {
      store.upsertSurfaceHealth({
        agentId: "agent_x",
        surface: "lark",
        status: "running",
        payload: {},
      });

      expect(store.getSurfaceHealthsForAgent("agent_x")).toHaveLength(1);
    });

    test("upsertSurfaceHealth updates existing", () => {
      store.upsertSurfaceHealth({
        agentId: "agent_x",
        surface: "lark",
        status: "running",
        payload: {},
      });
      store.upsertSurfaceHealth({
        agentId: "agent_x",
        surface: "lark",
        status: "degraded",
        payload: { error: "card failed" },
        lastError: "card update failed",
      });

      const health = store.getSurfaceHealth("agent_x", "lark");
      expect(health!.status).toBe("degraded");
      expect(health!.lastError).toBe("card update failed");
    });
  });
});

describe("computeRunnerStatus", () => {
  test("returns unknown for undefined row", () => {
    expect(computeRunnerStatus(undefined, 1000, 30000)).toBe("unknown");
  });

  test("returns offline when lastSeenAt is too old", () => {
    expect(
      computeRunnerStatus(
        {
          agentId: "a",
          lastSeenAt: 1000,
          uptimeMs: 0,
          activeRunCount: 0,
          activeRunIds: "[]",
          checkpointerOk: 1,
          workspaceOk: 1,
          lastError: null,
          updatedAt: 1000,
        },
        40000,
        30000,
      ),
    ).toBe("offline");
  });

  test("returns degraded when checkpointer is not ok", () => {
    expect(
      computeRunnerStatus(
        {
          agentId: "a",
          lastSeenAt: 1000,
          uptimeMs: 0,
          activeRunCount: 0,
          activeRunIds: "[]",
          checkpointerOk: 0,
          workspaceOk: 1,
          lastError: null,
          updatedAt: 1000,
        },
        2000,
        30000,
      ),
    ).toBe("degraded");
  });

  test("returns busy when activeRunCount > 0", () => {
    expect(
      computeRunnerStatus(
        {
          agentId: "a",
          lastSeenAt: 1000,
          uptimeMs: 0,
          activeRunCount: 3,
          activeRunIds: "[]",
          checkpointerOk: 1,
          workspaceOk: 1,
          lastError: null,
          updatedAt: 1000,
        },
        2000,
        30000,
      ),
    ).toBe("busy");
  });

  test("returns idle when no active runs", () => {
    expect(
      computeRunnerStatus(
        {
          agentId: "a",
          lastSeenAt: 1000,
          uptimeMs: 0,
          activeRunCount: 0,
          activeRunIds: "[]",
          checkpointerOk: 1,
          workspaceOk: 1,
          lastError: null,
          updatedAt: 1000,
        },
        2000,
        30000,
      ),
    ).toBe("idle");
  });
});
