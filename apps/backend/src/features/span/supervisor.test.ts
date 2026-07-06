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

  test("startSpan creates run/attempt rows and returns RunSpan", async () => {
    const db = testDB();
    const s = mockSupervisor(db);
    const span = await s.startSpan("r2", "t2");
    expect(span.spanId).toBe("r2");
    expect(span.sessionId).toBe("t2");
    const run = db.query("SELECT * FROM span WHERE span_id = ?").get("r2") as { status: string };
    expect(run.status).toBe("running");
    s.dispose();
    db.close();
  });

  test("startSpan with origin writes span_origin row", async () => {
    const db = testDB();
    const s = mockSupervisor(db);
    const span = await s.startSpan("r3", "t3", {
      conversationId: "c1",
      agentMemberId: "a1",
      surface: "web",
      originKind: "manual",
    });
    expect(span.spanId).toBe("r3");
    const origin = db.query("SELECT * FROM span_origin WHERE span_id = ?").get("r3") as {
      conversation_id: string;
      agent_member_id: string;
    };
    expect(origin.conversation_id).toBe("c1");
    expect(origin.agent_member_id).toBe("a1");
    s.dispose();
    db.close();
  });

  test("span.end fires onRunComplete with status", async () => {
    const db = testDB();
    const s = mockSupervisor(db);
    const done: string[] = [];
    s.onRunComplete((_sid, _rid, status) => {
      done.push(status);
    });
    const span = await s.startSpan("r4", "t4");
    span.end("succeeded");
    // span.end calls notifyRunComplete asynchronously — await microtask
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toEqual(["succeeded"]);
    s.dispose();
    db.close();
  });

  test("span.end is idempotent", async () => {
    const db = testDB();
    const s = mockSupervisor(db);
    const done: string[] = [];
    s.onRunComplete((_sid, _rid, status) => {
      done.push(status);
    });
    const span = await s.startSpan("r5", "t5");
    span.end("succeeded");
    span.end("error"); // should be no-op
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toEqual(["succeeded"]);
    s.dispose();
    db.close();
  });
});
