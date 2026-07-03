import { describe, expect, test } from "bun:test";
import { mockSupervisor, testDB } from "../../../test-helpers/mock-deps.js";

describe("RunSupervisor", () => {
  test("startMainRun creates run and attempt rows", async () => {
    const db = testDB();
    const s = mockSupervisor(db);
    const { spanId, attemptSeq } = await s.startMainRun("r1", "t1", { agentId: "a1" });
    expect(spanId).toBe("r1");
    expect(attemptSeq).toBe(1);
    const run = db.query("SELECT * FROM span WHERE span_id = ?").get("r1") as { status: string };
    expect(run.status).toBe("running");
    s.dispose();
    db.close();
  });

  test("cancel returns true for active run, false for missing", async () => {
    const db = testDB();
    const s = mockSupervisor(db);
    await s.startMainRun("r1", "t1", { agentId: "a1" });
    expect(s.cancel("r1")).toBe(true);
    expect(s.cancel("gone")).toBe(false);
    s.dispose();
    db.close();
  });

  test("onRunComplete callback fires via notifyRunComplete", async () => {
    const db = testDB();
    const s = mockSupervisor(db);
    const done: string[] = [];
    s.onRunComplete((_tid, _rid, status) => {
      done.push(status);
    });
    await s.notifyRunComplete("t1", "r1", "succeeded", "main", null);
    expect(done).toEqual(["succeeded"]);
    s.dispose();
    db.close();
  });
});
