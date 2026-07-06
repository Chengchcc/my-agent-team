import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { RuntimeOpsStore } from "./store.js";

function createTestDb() {
  // S1: events.db merged into backend.db — use openDb to run unified migrations.
  return openDb(":memory:");
}

describe("RuntimeOpsStore", () => {
  let db: Database;
  let store: RuntimeOpsStore;

  beforeEach(() => {
    db = createTestDb();
    store = new RuntimeOpsStore(db);
  });

  afterEach(() => db.close());

  describe("control_plane_event", () => {
    test("appendControlPlaneEvent and getControlPlaneEvents round-trip", () => {
      store.appendControlPlaneEvent({
        spanId: "r1",
        attemptSeq: 1,
        kind: "retry_requested",
        payload: { mode: "run" },
        traceId: "trace-abc",
      });

      const events = store.getControlPlaneEvents("r1");
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe("retry_requested");
      expect(events[0]!.spanId).toBe("r1");
      expect(events[0]!.attemptSeq).toBe(1);
      expect(events[0]!.traceId).toBe("trace-abc");
    });

    test("getControlPlaneEvents returns events ordered by seq", () => {
      store.appendControlPlaneEvent({ spanId: "r1", kind: "retry_requested" });
      store.appendControlPlaneEvent({ spanId: "r1", kind: "retry_started" });
      store.appendControlPlaneEvent({ spanId: "r1", kind: "projection_degraded" });

      const events = store.getControlPlaneEvents("r1");
      expect(events).toHaveLength(3);
      expect(events[0]!.kind).toBe("retry_requested");
      expect(events[2]!.kind).toBe("projection_degraded");
    });

    test("getControlPlaneEventsByTrace filters correctly", () => {
      store.appendControlPlaneEvent({ spanId: "r1", kind: "retry_requested", traceId: "t1" });
      store.appendControlPlaneEvent({ spanId: "r2", kind: "retry_requested", traceId: "t1" });
      store.appendControlPlaneEvent({ spanId: "r3", kind: "retry_requested", traceId: "t2" });

      expect(store.getControlPlaneEventsByTrace("t1")).toHaveLength(2);
      expect(store.getControlPlaneEventsByTrace("t2")).toHaveLength(1);
    });

    test("appendControlPlaneEvent without optional fields", () => {
      store.appendControlPlaneEvent({ spanId: "r1", kind: "projection_degraded" });
      const events = store.getControlPlaneEvents("r1");
      expect(events).toHaveLength(1);
      expect(events[0]!.attemptSeq).toBeNull();
      expect(events[0]!.traceId).toBeNull();
    });
  });

  describe("run_origin", () => {
    test("insert and get by spanId", () => {
      store.insertSpanOrigin({
        spanId: "r1",
        conversationId: "c1",
        sourceLedgerSeq: 5,
        agentMemberId: "agent:x",
        surface: "web",
        idempotencyKey: "ik-1",
        fromStatus: "",
        originKind: "manual",
        createdAt: 1000,
      });

      const row = store.getSpanOrigin("r1");
      expect(row).not.toBeNull();
      expect(row!.conversationId).toBe("c1");
      expect(row!.sourceLedgerSeq).toBe(5);
    });

    test("idempotent on duplicate idempotencyKey (INSERT OR IGNORE)", () => {
      const row = {
        spanId: "r1",
        conversationId: "c1",
        sourceLedgerSeq: 5,
        agentMemberId: "agent:x",
        surface: "web" as const,
        idempotencyKey: "ik-dup",
        fromStatus: "",
        originKind: "manual" as const,
        createdAt: 1000,
      };
      store.insertSpanOrigin(row);
      // Second insert with same idempotencyKey should be silently ignored
      expect(() => store.insertSpanOrigin({ ...row, spanId: "r2" })).not.toThrow();
      // The original row is still there — verify via getSpanOrigin(spanId)
      const origin = store.getSpanOrigin("r1");
      expect(origin).not.toBeNull();
      expect(origin!.spanId).toBe("r1");
      // r2 never made it in (INSERT OR IGNORE blocked it, but run_origin PK is span_id so r2 would get its own row if key differed)
      expect(store.getSpanOrigin("r2")).toBeNull();
    });

    test("getSpanOrigin returns null for missing run", () => {
      expect(store.getSpanOrigin("nonexistent")).toBeNull();
    });
  });

  // runner_health tests removed — runner daemon deleted, health no longer tracked

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

  describe("issue_event", () => {
    test("appendIssueEvent writes and returns seq", () => {
      const seq = store.appendIssueEvent({
        issueId: "i1",
        kind: "created",
        payload: { title: "Test" },
      });
      expect(typeof seq).toBe("number");
      expect(seq).toBeGreaterThan(0);
    });

    test("getIssueEvents returns events ordered by seq", () => {
      store.appendIssueEvent({ issueId: "i1", kind: "created" });
      store.appendIssueEvent({ issueId: "i1", kind: "started" });
      store.appendIssueEvent({ issueId: "i2", kind: "created" });

      const events = store.getIssueEvents("i1");
      expect(events.length).toBe(2);
      expect(events[0]!.kind).toBe("created");
      expect(events[1]!.kind).toBe("started");
      expect(events[0]!.seq).toBeLessThan(events[1]!.seq);
    });

    test("getIssueEvents afterSeq filters incrementally", () => {
      store.appendIssueEvent({ issueId: "i1", kind: "created" });
      const s2 = store.appendIssueEvent({ issueId: "i1", kind: "started" });

      const events = store.getIssueEvents("i1", s2);
      expect(events.length).toBe(0);

      const eventsAfterFirst = store.getIssueEvents("i1", 0);
      expect(eventsAfterFirst.length).toBe(2);
    });

    test("payload round-trips through JSON", () => {
      store.appendIssueEvent({
        issueId: "i1",
        kind: "run.started",
        payload: { spanId: "r1", fromStatus: "planned", agentId: "a1" },
      });
      const events = store.getIssueEvents("i1");
      expect(events[0]!.payload).toEqual({
        spanId: "r1",
        fromStatus: "planned",
        agentId: "a1",
      });
    });
  });

  describe("getSpanOriginsByIssueId", () => {
    test("returns runs for an issue ordered by created_at", () => {
      store.insertSpanOrigin({
        spanId: "r1",
        issueId: "i1",
        conversationId: "",
        sourceLedgerSeq: 0,
        agentMemberId: "a1",
        surface: "orchestrator",
        idempotencyKey: "r1",
        fromStatus: "planned",
        originKind: "orchestrator",
        createdAt: 1000,
      });
      store.insertSpanOrigin({
        spanId: "r2",
        issueId: "i1",
        conversationId: "",
        sourceLedgerSeq: 0,
        agentMemberId: "a2",
        surface: "orchestrator",
        idempotencyKey: "r2",
        fromStatus: "in_progress",
        originKind: "orchestrator",
        createdAt: 2000,
      });
      store.insertSpanOrigin({
        spanId: "r3",
        issueId: "i2",
        conversationId: "",
        sourceLedgerSeq: 0,
        agentMemberId: "a1",
        surface: "orchestrator",
        idempotencyKey: "r3",
        fromStatus: "planned",
        originKind: "orchestrator",
        createdAt: 1500,
      });

      const origins = store.getSpanOriginsByIssueId("i1");
      expect(origins.length).toBe(2);
      expect(origins[0]!.spanId).toBe("r1");
      expect(origins[1]!.spanId).toBe("r2");
    });

    test("returns empty array for unknown issue", () => {
      expect(store.getSpanOriginsByIssueId("nonexistent")).toEqual([]);
    });
  });

  describe("getRuns", () => {
    test("batch fetches runs by runIds", () => {
      db.run(
        `INSERT INTO span (span_id, session_id, agent_id, status, started_at) VALUES ('r1', 't1', 'a1', 'succeeded', 1000)`,
      );
      db.run(
        `INSERT INTO span (span_id, session_id, agent_id, status, started_at) VALUES ('r2', 't2', 'a2', 'failed', 2000)`,
      );
      db.run(
        `INSERT INTO span (span_id, session_id, agent_id, status, started_at) VALUES ('r3', 't3', 'a1', 'running', 3000)`,
      );

      const runs = store.getRuns(["r1", "r3"]);
      expect(runs.length).toBe(2);
      expect(runs.find((r) => r.spanId === "r1")!.status).toBe("succeeded");
      expect(runs.find((r) => r.spanId === "r3")!.status).toBe("running");
    });

    test("returns empty array for empty input", () => {
      expect(store.getRuns([])).toEqual([]);
    });
  });
});
