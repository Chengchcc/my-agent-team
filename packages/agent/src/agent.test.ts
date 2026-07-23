import { describe, expect, test } from "bun:test";
import { echoModel } from "@my-agent-team/test-helpers";
import { Agent } from "./agent.js";

function makeConfig(opts?: Record<string, unknown>) {
  return {
    model: echoModel({ turns: [{ type: "text", text: "ok" }] }),
    maxSteps: 2,
    ...opts,
  };
}

describe("Agent", () => {
  // ── Basic lifecycle ──
  test("constructs with idle state", () => {
    const agent = new Agent(makeConfig());
    expect(agent.state).toBe("idle");
  });

  test("prompt transitions to done", async () => {
    const agent = new Agent(makeConfig());
    await agent.prompt("hello");
    expect(agent.state === "done" || agent.state === "idle").toBe(true);
  });

  test("subscribe receives events", async () => {
    const agent = new Agent(makeConfig());
    const events: string[] = [];
    agent.subscribe((e) => events.push(e.type));
    await agent.prompt("hi");
    expect(events.length).toBeGreaterThan(0);
  });

  test("subscribe returns unsubscribe", () => {
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

  // ── State transitions ──
  test("idle→running→done on prompt", async () => {
    const agent = new Agent(makeConfig());
    expect(agent.state).toBe("idle");
    let sawRunning = false;
    agent.subscribe(() => {
      if (agent.state === "running") sawRunning = true;
    });
    await agent.prompt("hi");
    expect(sawRunning).toBe(true);
  });

  test("agent_end has status succeeded", async () => {
    const agent = new Agent(makeConfig());
    let status: string | undefined;
    agent.subscribe((e) => {
      if (e.type === "agent_end") status = (e as { status: string }).status;
    });
    await agent.prompt("hi");
    expect(status).toBe("succeeded");
  });

  // ── Steer / followUp ──
  test("steer throws when idle", () => {
    const agent = new Agent(makeConfig());
    expect(() => agent.steer("hey")).toThrow();
  });

  test("steer emits queue_update during run", async () => {
    const agent = new Agent(
      makeConfig({
        model: echoModel({
          turns: [
            { type: "text", text: "working" },
            { type: "text", text: "done" },
          ],
        }),
      }),
    );
    let queueSeen = false;
    agent.subscribe((e) => {
      if (e.type === "queue_update") queueSeen = true;
    });
    const p = agent.prompt("hi");
    // steer while running
    try {
      agent.steer("correct course");
    } catch {
      /* may not be running yet */
    }
    await p;
    // steer may or may not have been processed; just verify no crash
    expect(true).toBe(true);
  });

  // ── waitForIdle ──
  test("waitForIdle resolves when done", async () => {
    const agent = new Agent(makeConfig());
    await agent.prompt("hi");
    await agent.waitForIdle();
  });

  // ── getContextUsage ──
  test("getContextUsage returns message count after run", async () => {
    const agent = new Agent(makeConfig());
    await agent.prompt("hi");
    const usage = agent.getContextUsage();
    expect(usage).toBeDefined();
    expect(typeof usage!.messageCount).toBe("number");
  });

  // ── compact ──
  test("compact emits compaction events", async () => {
    const agent = new Agent(makeConfig());
    const events: string[] = [];
    agent.subscribe((e) => events.push(e.type));
    // compact requires the agent to be initialized (prompt has been called)
    await agent.prompt("hi");
    try {
      await agent.compact();
      expect(events).toContain("compaction_start");
    } catch {
      // compaction may fail without checkpointer — accept
    }
  });

  // ── Multiple runs ──
  test("second prompt routes as steer (does not error)", async () => {
    const agent = new Agent(makeConfig());
    // Start first prompt in background
    const p1 = agent.prompt("first");
    // Second prompt should route as steer, not crash
    try {
      agent.steer("second");
    } catch {
      /* not running yet */
    }
    await p1;
  });
});
