import { describe, expect, test } from "bun:test";
import { echoModel } from "@my-agent-team/test-helpers";
import { InMemorySessionManager } from "./session-manager.js";

function makeConfig() {
  return { model: echoModel({ turns: [{ type: "text", text: "ok" }] }), maxSteps: 2 };
}

describe("SessionManager", () => {
  test("create generates unique sessionId", () => {
    const mgr = new InMemorySessionManager();
    const agent = mgr.create(makeConfig());
    expect(agent.sessionId).toBeDefined();
    expect(typeof agent.sessionId).toBe("string");
  });

  test("create preserves provided sessionId", () => {
    const mgr = new InMemorySessionManager();
    const agent = mgr.create({ ...makeConfig(), sessionId: "fixed-id" });
    expect(agent.sessionId).toBe("fixed-id");
  });

  test("two create calls produce different sessionIds", () => {
    const mgr = new InMemorySessionManager();
    const a1 = mgr.create(makeConfig());
    const a2 = mgr.create(makeConfig());
    expect(a1.sessionId).not.toBe(a2.sessionId);
  });

  test("open hits memory for live agent", () => {
    const mgr = new InMemorySessionManager();
    const cfg = makeConfig();
    const a1 = mgr.create({ ...cfg, sessionId: "mem-test" });
    const a2 = mgr.open("mem-test", cfg);
    expect(a1).toBe(a2);
  });

  test("open creates new agent on memory miss", () => {
    const mgr = new InMemorySessionManager();
    const a = mgr.open("not-found", makeConfig());
    expect(a.sessionId).toBe("not-found");
  });

  test("get returns existing agent", () => {
    const mgr = new InMemorySessionManager();
    const a = mgr.create({ ...makeConfig(), sessionId: "get-test" });
    expect(mgr.get("get-test")).toBe(a);
  });

  test("get returns undefined for unknown", () => {
    const mgr = new InMemorySessionManager();
    expect(mgr.get("nope")).toBeUndefined();
  });

  test("dispose removes live agent", () => {
    const mgr = new InMemorySessionManager();
    mgr.create({ ...makeConfig(), sessionId: "disp-test" });
    mgr.dispose("disp-test");
    expect(mgr.get("disp-test")).toBeUndefined();
  });

  test("recovery: open after dispose + prompt", async () => {
    const mgr1 = new InMemorySessionManager();
    const cfg = makeConfig();
    const id = "recovery-test";
    const a1 = mgr1.create({ ...cfg, sessionId: id });
    await a1.prompt("first message");
    mgr1.dispose(id);
    const mgr2 = new InMemorySessionManager();
    const a2 = mgr2.open(id, cfg);
    await a2.continue();
    expect(a2.sessionId).toBe(id);
  });
});
