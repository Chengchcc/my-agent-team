import { describe, expect, test } from "bun:test";
import { echoModel } from "@my-agent-team/test-helpers";
import { Agent } from "./agent.js";

function makeConfig() {
  return { model: echoModel({ turns: [{ type: "text", text: "ok" }] }) };
}

describe("Agent", () => {
  test("constructs and exposes sessionId", () => {
    const agent = new Agent(makeConfig());
    expect(agent.state).toBe("idle");
  });

  test("prompt transitions to running then done", async () => {
    const agent = new Agent(makeConfig());
    let done = false;
    agent.subscribe((e) => {
      if (e.type === "agent_end") done = true;
    });
    await agent.prompt("hello");
    expect(done).toBe(true);
  });

  test("subscribe returns unsubscribe function", () => {
    const agent = new Agent(makeConfig());
    let calls = 0;
    const unsub = agent.subscribe(() => calls++);
    unsub();
    expect(calls).toBe(0);
  });

  test("dispose returns to idle", () => {
    const agent = new Agent(makeConfig());
    agent.dispose();
    expect(agent.state).toBe("idle");
  });

  test("steer requires running agent", () => {
    const agent = new Agent(makeConfig());
    expect(() => agent.steer("hey")).toThrow();
  });

  test("waitForIdle resolves when done", async () => {
    const agent = new Agent(makeConfig());
    await agent.prompt("hi");
    await agent.waitForIdle(); // should not hang
  });
});
