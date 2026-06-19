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
    idempotency_key TEXT,
    created_at     INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_deliverable_idem ON deliverable(idempotency_key) WHERE idempotency_key IS NOT NULL`);
  let idCounter = 0;
  const svc = createDeliverableService({
    port: sqliteDeliverableAdapter(db),
    idGen: () => `d_${String(++idCounter).padStart(3, "0")}`,
    now: () => 1000 + idCounter,
  });
  return { db, svc };
}

describe("DeliverableService", () => {
  test("submit inserts a row and returns it", () => {
    const { svc } = setup();
    const row = svc.submit({
      issueId: "iss_001",
      fromStatus: "planned",
      kind: "plan",
      fields: { summary: "Build a thing", url: "https://doc.example/plan" },
      ref: "https://doc.example/plan",
      runId: "run_001",
      idempotencyKey: "issue:iss_001:planned:deliverable",
    });
    expect(row.issueId).toBe("iss_001");
    expect(row.fromStatus).toBe("planned");
    expect(row.kind).toBe("plan");
    expect(row.fields).toEqual({ summary: "Build a thing", url: "https://doc.example/plan" });
    expect(row.ref).toBe("https://doc.example/plan");
    expect(row.runId).toBe("run_001");
  });

  test("listByIssue returns rows ordered by created_at ASC", () => {
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

  test("same (issueId, kind) can have multiple rows (append-only)", () => {
    const { svc } = setup();
    svc.submit({ issueId: "iss_001", fromStatus: "planned", kind: "plan", fields: { v: "1" } });
    svc.submit({ issueId: "iss_001", fromStatus: "planned", kind: "plan", fields: { v: "2" } });

    const rows = svc.port.listByIssue("iss_001");
    expect(rows).toHaveLength(2);
    expect(rows[1]!.fields).toEqual({ v: "2" });
  });

  test("getByIdempotencyKey finds existing row", () => {
    const { svc } = setup();
    svc.submit({
      issueId: "iss_001",
      fromStatus: "planned",
      kind: "plan",
      fields: { v: "1" },
      idempotencyKey: "key_abc",
    });

    const found = svc.port.getByIdempotencyKey("key_abc");
    expect(found).not.toBeNull();
    expect(found!.issueId).toBe("iss_001");
  });

  test("getByIdempotencyKey returns null for unknown key", () => {
    const { svc } = setup();
    expect(svc.port.getByIdempotencyKey("nonexistent")).toBeNull();
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
