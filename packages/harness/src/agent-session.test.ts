import { describe, expect, test } from "bun:test";
import type { AIMessageChunk, ChatModel } from "@my-agent-team/core";
import { AgentSession } from "./agent-session.js";

function echoModel(text: string): ChatModel {
  return {
    id: "echo",
    async *stream(): AsyncIterable<AIMessageChunk> {
      yield { delta: { type: "text", text } };
      yield { done: true, stopReason: "end_turn" };
    },
  };
}

describe("AgentSession", () => {
  test("prompt runs and reaches done state", async () => {
    const model = echoModel("hello world");
    const session = new AgentSession({ model });
    const events: string[] = [];
    session.subscribe((e) => events.push(e.type));

    await session.prompt("hi");

    expect(session.state).toBe("done");
    expect(events).toContain("message");
    expect(events).toContain("agent_end");
    session.dispose();
  });

  test("subscribe returns unsubscribe function", async () => {
    const model = echoModel("hello");
    const session = new AgentSession({ model });
    const events: string[] = [];
    const unsub = session.subscribe((e) => events.push(e.type));
    unsub();

    await session.prompt("hi");

    expect(events.length).toBe(0);
    session.dispose();
  });

  test("state transitions idle → running → done", async () => {
    const model = echoModel("ok");
    const session = new AgentSession({ model });
    const states: string[] = [];
    session.subscribe(() => states.push(session.state));

    await session.prompt("test");

    expect(session.state).toBe("done");
    expect(states.length).toBeGreaterThan(0);
    session.dispose();
  });

  test("agent_end event includes willRetry: false on success", async () => {
    const model = echoModel("success");
    const session = new AgentSession({ model });
    let agentEndEvent: unknown = null;
    session.subscribe((e) => {
      if (e.type === "agent_end") agentEndEvent = e;
    });

    await session.prompt("hi");

    expect(agentEndEvent).toBeDefined();
    expect((agentEndEvent as Record<string, unknown>)?.willRetry).toBe(false);
    session.dispose();
  });

  test("dispose cleans up", async () => {
    const model = echoModel("ok");
    const session = new AgentSession({ model });
    const events: string[] = [];
    session.subscribe((e) => events.push(e.type));

    await session.prompt("hi");
    session.dispose();

    // After dispose, state resets
    expect(session.state).toBe("idle");
  });

  test("getContextUsage returns message count", async () => {
    const model = echoModel("ok");
    const session = new AgentSession({ model });

    await session.prompt("hi");

    const usage = session.getContextUsage();
    expect(usage).toBeDefined();
    expect(usage!.messageCount).toBeGreaterThan(0);
    session.dispose();
  });

  test("waitForIdle resolves when done", async () => {
    const model = echoModel("ok");
    const session = new AgentSession({ model });

    await session.prompt("hi");

    // After prompt completes, state should be done
    expect(session.state).toBe("done");
    session.dispose();
  });
});
