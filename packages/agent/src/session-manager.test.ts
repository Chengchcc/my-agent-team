import { describe, expect, test } from "bun:test";
import { echoModel } from "@my-agent-team/test-helpers";
import { SessionManager } from "./session-manager.js";

function makeConfig() {
  return { model: echoModel({ turns: [{ type: "text", text: "ok" }] }), maxSteps: 2 };
}

describe("SessionManager", () => {
  test("create generates unique sessionId when none provided", () => {
    const mgr = new SessionManager();
    const agent = mgr.create(makeConfig());
    expect(agent.sessionId).toBeDefined();
    expect(typeof agent.sessionId).toBe("string");
  });

  test("create preserves provided sessionId", () => {
    const mgr = new SessionManager();
    const agent = mgr.create({ ...makeConfig(), sessionId: "fixed-id" });
    expect(agent.sessionId).toBe("fixed-id");
  });

  test("two create calls produce different sessionIds", () => {
    const mgr = new SessionManager();
    const a1 = mgr.create(makeConfig());
    const a2 = mgr.create(makeConfig());
    expect(a1.sessionId).not.toBe(a2.sessionId);
  });

  test("open hits memory for live agent", () => {
    const mgr = new SessionManager();
    const cfg = makeConfig();
    const a1 = mgr.create({ ...cfg, sessionId: "mem-test" });
    const a2 = mgr.open("mem-test", cfg);
    expect(a1).toBe(a2); // same reference
  });

  test("open creates new agent on memory miss", () => {
    const mgr = new SessionManager();
    const a = mgr.open("not-found", makeConfig());
    expect(a.sessionId).toBe("not-found");
    expect(a.state).toBe("idle");
  });

  test("get returns existing agent", () => {
    const mgr = new SessionManager();
    const a = mgr.create({ ...makeConfig(), sessionId: "get-test" });
    expect(mgr.get("get-test")).toBe(a);
  });

  test("get returns undefined for unknown", () => {
    const mgr = new SessionManager();
    expect(mgr.get("nope")).toBeUndefined();
  });

  test("dispose removes live agent", () => {
    const mgr = new SessionManager();
    mgr.create({ ...makeConfig(), sessionId: "disp-test" });
    mgr.dispose("disp-test");
    expect(mgr.get("disp-test")).toBeUndefined();
  });
});
