import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { sqliteDeliverableAdapter } from "./adapter-sqlite.js";
import { createDeliverableService } from "./service.js";

function setup() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE IF NOT EXISTS deliverable (
    deliverable_id TEXT PRIMARY KEY,
    issue_id       TEXT NOT NULL,
    from_status    TEXT NOT NULL,
    kind           TEXT NOT NULL,
    fields         TEXT NOT NULL,
    ref            TEXT,
    run_id         TEXT,
    created_at     INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_deliverable_run_kind ON deliverable(run_id, kind) WHERE run_id IS NOT NULL`);
  let idCounter = 0;
  const svc = createDeliverableService({
    port: sqliteDeliverableAdapter(db),
    idGen: () => `d_${String(++idCounter).padStart(3, "0")}`,
    now: () => 1000 + idCounter,
  });
  return { db, svc };
}

describe("DeliverableService", () => {
  test("submit inserts a row and returns it with replay=false", () => {
    const { svc } = setup();
    const { row, replay } = svc.submit({
      issueId: "iss_001",
      fromStatus: "planned",
      kind: "plan",
      fields: { summary: "Build a thing", url: "https://doc.example/plan" },
      ref: "https://doc.example/plan",
      runId: "run_001",
    });
    expect(replay).toBe(false);
    expect(row.issueId).toBe("iss_001");
    expect(row.fromStatus).toBe("planned");
    expect(row.kind).toBe("plan");
    expect(row.fields).toEqual({ summary: "Build a thing", url: "https://doc.example/plan" });
    expect(row.ref).toBe("https://doc.example/plan");
    expect(row.runId).toBe("run_001");
  });

  test("submit same (runId, kind) returns replay=true with existing row", () => {
    const { svc } = setup();
    const first = svc.submit({
      issueId: "iss_001",
      fromStatus: "planned",
      kind: "plan",
      fields: { v: "1" },
      runId: "run_001",
    });
    expect(first.replay).toBe(false);

    const second = svc.submit({
      issueId: "iss_001",
      fromStatus: "planned",
      kind: "plan",
      fields: { v: "2" },
      runId: "run_001",
    });
    expect(second.replay).toBe(true);
    // Returns the first row, not the second (ON CONFLICT DO NOTHING)
    expect(second.row.fields).toEqual({ v: "1" });
    expect(second.row.deliverableId).toBe(first.row.deliverableId);
  });

  test("different kind for same run inserts separately (no conflict)", () => {
    const { svc } = setup();
    const plan = svc.submit({
      issueId: "iss_001",
      fromStatus: "planned",
      kind: "plan",
      fields: { v: "1" },
      runId: "run_001",
    });
    const mr = svc.submit({
      issueId: "iss_001",
      fromStatus: "planned",
      kind: "mr",
      fields: { v: "2" },
      runId: "run_001",
    });
    expect(plan.replay).toBe(false);
    expect(mr.replay).toBe(false);
    const rows = svc.listByIssue("iss_001");
    expect(rows).toHaveLength(2);
  });

  test("different run for same kind inserts separately (rework produces new row)", () => {
    const { svc } = setup();
    const first = svc.submit({
      issueId: "iss_001",
      fromStatus: "planned",
      kind: "plan",
      fields: { v: "1" },
      runId: "run_001",
    });
    const second = svc.submit({
      issueId: "iss_001",
      fromStatus: "planned",
      kind: "plan",
      fields: { v: "2" },
      runId: "run_002",
    });
    expect(first.replay).toBe(false);
    expect(second.replay).toBe(false);
    const rows = svc.listByIssue("iss_001");
    expect(rows).toHaveLength(2);
  });

  test("listByIssue returns rows ordered by created_at ASC, deliverable_id ASC", () => {
    const { svc } = setup();
    svc.submit({ issueId: "iss_001", fromStatus: "planned", kind: "plan", fields: { v: "1" } });
    svc.submit({ issueId: "iss_001", fromStatus: "in_progress", kind: "mr", fields: { v: "2" } });
    svc.submit({ issueId: "iss_002", fromStatus: "planned", kind: "plan", fields: { v: "3" } });

    const rows = svc.listByIssue("iss_001");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.kind).toBe("plan");
    expect(rows[1]!.kind).toBe("mr");
    expect(rows[0]!.createdAt).toBeLessThan(rows[1]!.createdAt);
  });

  test("same (issueId, kind) without runId can have multiple rows (append-only, no unique conflict)", () => {
    const { svc } = setup();
    svc.submit({ issueId: "iss_001", fromStatus: "planned", kind: "plan", fields: { v: "1" } });
    svc.submit({ issueId: "iss_001", fromStatus: "planned", kind: "plan", fields: { v: "2" } });

    const rows = svc.port.listByIssue("iss_001");
    expect(rows).toHaveLength(2);
    expect(rows[1]!.fields).toEqual({ v: "2" });
  });

  test("getByRunAndKind finds existing row", () => {
    const { svc } = setup();
    svc.submit({
      issueId: "iss_001",
      fromStatus: "planned",
      kind: "plan",
      fields: { v: "1" },
      runId: "run_001",
    });

    const found = svc.port.getByRunAndKind("run_001", "plan");
    expect(found).not.toBeNull();
    expect(found!.issueId).toBe("iss_001");
  });

  test("getByRunAndKind returns null for unknown (runId, kind)", () => {
    const { svc } = setup();
    expect(svc.port.getByRunAndKind("nonexistent", "plan")).toBeNull();
  });

  test("fields JSON round-trips correctly", () => {
    const { svc } = setup();
    svc.submit({
      issueId: "iss_001",
      fromStatus: "planned",
      kind: "plan",
      fields: { summary: "hello", nested: '{"key":"val"}' },
    });
    const rows = svc.port.listByIssue("iss_001");
    expect(rows[0]!.fields).toEqual({ summary: "hello", nested: '{"key":"val"}' });
  });
});
