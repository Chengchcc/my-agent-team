import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SqliteSessionManager } from "@my-agent-team/agent";
import { echoModel } from "@my-agent-team/test-helpers";
import { mockConfig } from "../../../test-helpers/mock-deps.js";
import { openDb } from "../../infra/sqlite/db.js";
import { RuntimeOpsStore } from "../runtime-ops/store.js";
import { SpanSupervisor } from "./supervisor.js";

function makeDeps() {
  const db = openDb(":memory:");
  const opsStore = new RuntimeOpsStore(db);
  const supervisor = new SpanSupervisor({
    config: mockConfig(),
    opsStore,
    tracer: {
      inject: () => ({ traceparent: "" }),
      startSpan: () => ({}),
      currentTrace: () => null,
      link: () => {},
    } as never,
    db,
  });
  const manager = new SqliteSessionManager({
    checkpointerPath: join(mockConfig().dataDir, "checkpointer.db"),
    startSpan: (sid, sid2, opts) => supervisor.startSpan(sid, sid2, opts),
  });
  return { db, manager, supervisor, opsStore };
}

describe("SqliteSessionManager", () => {
  test("create generates ULID sessionId and registers in memory", () => {
    const { manager } = makeDeps();
    const session = manager.create({ model: echoModel({ turns: [{ type: "text", text: "ok" }] }) });
    expect(session.sessionId ?? "").toBeTruthy();
    expect((session.sessionId ?? "").length).toBeGreaterThan(10);
    // get returns the same object
    expect(manager.get(session.sessionId ?? "")).toBe(session);
  });

  test("open returns existing session when in memory", () => {
    const { manager } = makeDeps();
    const config = { model: echoModel({ turns: [{ type: "text", text: "ok" }] }) };
    const session1 = manager.create(config);
    const session2 = manager.open(session1.sessionId ?? "", config);
    expect(session2).toBe(session1);
  });

  test("open creates new session when not in memory", () => {
    const { manager } = makeDeps();
    const config = { model: echoModel({ turns: [{ type: "text", text: "ok" }] }) };
    const session = manager.open("01JXTESTSESSIONID", config);
    expect(session.sessionId ?? "").toBe("01JXTESTSESSIONID");
    expect(manager.get("01JXTESTSESSIONID")).toBe(session);
  });

  test("get returns undefined for unknown sessionId", () => {
    const { manager } = makeDeps();
    expect(manager.get("nonexistent")).toBeUndefined();
  });

  test("dispose removes session from memory", () => {
    const { manager } = makeDeps();
    const session = manager.create({ model: echoModel({ turns: [{ type: "text", text: "ok" }] }) });
    manager.dispose(session.sessionId ?? "");
    expect(manager.get(session.sessionId ?? "")).toBeUndefined();
  });

  test("create injects startSpan — prompt triggers supervisor.startSpan", async () => {
    const { manager, opsStore } = makeDeps();
    const session = manager.create({
      model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
    });

    await session.prompt("hi", {
      origin: { agentMemberId: "a1", originKind: "manual", conversationId: "c1" },
    });

    // startSpan should have written span_origin
    // Find any span_origin row with conversationId=c1
    const origins = opsStore.listSpanOrigins();
    const found = origins.find((o) => o.conversationId === "c1");
    expect(found).toBeTruthy();
    expect(found!.agentMemberId).toBe("a1");
  });
});
