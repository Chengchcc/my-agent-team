import { describe, expect, test } from "bun:test";
import { echoModel } from "@my-agent-team/test-helpers";
import { InMemorySessionManager } from "./session-manager.js";

function mc() {
  return { model: echoModel({ turns: [{ type: "text", text: "ok" }] }), maxSteps: 2 };
}
describe("SessionManager", () => {
  test("create generates unique sessionId", () => {
    const mgr = new InMemorySessionManager();
    const agent = mgr.create(mc());
    expect(agent.sessionId).toBeDefined();
    expect(typeof agent.sessionId).toBe("string");
  });
  test("create preserves provided sessionId", () => {
    const mgr = new InMemorySessionManager();
    const agent = mgr.create({ ...mc(), sessionId: "fixed-id" });
    expect(agent.sessionId).toBe("fixed-id");
  });
  test("two create calls produce different sessionIds", () => {
    const mgr = new InMemorySessionManager();
    expect(mgr.create(mc()).sessionId).not.toBe(mgr.create(mc()).sessionId);
  });
  test("open hits memory for live agent", () => {
    const mgr = new InMemorySessionManager();
    const cfg = mc();
    const a1 = mgr.create({ ...cfg, sessionId: "mem-test" });
    expect(mgr.open("mem-test", cfg)).toBe(a1);
  });
  test("open creates new agent on memory miss", () => {
    const mgr = new InMemorySessionManager();
    expect(mgr.open("not-found", mc()).sessionId).toBe("not-found");
  });
  test("get/dispose lifecycle", () => {
    const mgr = new InMemorySessionManager();
    mgr.create({ ...mc(), sessionId: "disp-test" });
    expect(mgr.get("disp-test")).toBeDefined();
    mgr.dispose("disp-test");
    expect(mgr.get("disp-test")).toBeUndefined();
  });
  test("recovery: create → prompt → dispose → open → prompt", async () => {
    const id = "rec-test";
    const m1 = new InMemorySessionManager();
    const a1 = m1.create({ ...mc(), sessionId: id });
    await a1.prompt("first");
    m1.dispose(id);
    const m2 = new InMemorySessionManager();
    const a2 = m2.open(id, mc());
    let done = false;
    a2.subscribe((e) => {
      if (e.type === "agent_end") done = true;
    });
    await a2.prompt("resumed");
    expect(done).toBe(true);
  });
});
