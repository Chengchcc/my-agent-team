/* eslint-disable require-yield */
import { describe, expect, test } from "bun:test";
import type { AIMessageChunk, ChatModel, Tool } from "@my-agent-team/core";
import { definePlugin, inMemoryCheckpointer } from "@my-agent-team/framework";
import type { Message } from "@my-agent-team/message";
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

  test("model that always throws → retry with backoff → ends with error", async () => {
    let callCount = 0;
    const model: ChatModel = {
      id: "failing",
      async *stream() {
        callCount++;
        throw new Error("API unavailable");
      },
    };
    const session = new AgentSession({ model, retry: { maxAttempts: 2, backoffMs: 10 } });
    const events: unknown[] = [];
    session.subscribe((e) => events.push(e));

    await session.prompt("hi");

    // Retry events emitted
    const retryStarts = events.filter((e) => (e as { type: string }).type === "auto_retry_start");
    expect(retryStarts.length).toBeGreaterThanOrEqual(1);
    // Attempt numbers should be sequential
    const attempt1 = retryStarts[0] as { attempt: number };
    expect(attempt1.attempt).toBe(1);

    const agentEnd = events.find((e) => (e as { type: string }).type === "agent_end") as {
      status: string;
    };
    expect(agentEnd).toBeDefined();
    expect(agentEnd.status).toBe("error");

    const retryEnd = events.find((e) => (e as { type: string }).type === "auto_retry_end") as {
      success: boolean;
    };
    expect(retryEnd).toBeDefined();
    expect(retryEnd.success).toBe(false);

    // Model was called multiple times (initial + retries)
    expect(callCount).toBeGreaterThanOrEqual(2);

    session.dispose();
  });

  test("model that succeeds after one failure → retry then succeed", async () => {
    let calls = 0;
    const model: ChatModel = {
      id: "flaky",
      async *stream() {
        calls++;
        if (calls === 1) throw new Error("temporary failure");
        yield { delta: { type: "text", text: "recovered!" } };
        yield { done: true, stopReason: "end_turn" };
      },
    };
    const session = new AgentSession({ model, retry: { maxAttempts: 3, backoffMs: 10 } });
    const events: unknown[] = [];
    session.subscribe((e) => events.push(e));

    await session.prompt("hi");

    const retryStart = events.find((e) => (e as { type: string }).type === "auto_retry_start");
    expect(retryStart).toBeDefined();

    const agentEnd = events.find((e) => (e as { type: string }).type === "agent_end") as {
      status: string;
    };
    expect(agentEnd.status).toBe("succeeded");

    const retryEnd = events.find((e) => (e as { type: string }).type === "auto_retry_end") as {
      success: boolean;
    };
    expect(retryEnd.success).toBe(true);

    session.dispose();
  });

  test("model with zero blocks → treated as error after retries", async () => {
    const model: ChatModel = {
      id: "empty",
      async *stream() {
        // Stream ends immediately without any content blocks
        yield { done: true, stopReason: "end_turn" };
      },
    };
    const session = new AgentSession({ model, retry: { maxAttempts: 2, backoffMs: 10 } });
    const events: unknown[] = [];
    session.subscribe((e) => events.push(e));

    await session.prompt("hi");

    // Should end with error (zero blocks → span-loop throws)
    const agentEnd = events.find((e) => (e as { type: string }).type === "agent_end") as {
      status: string;
    };
    expect(agentEnd).toBeDefined();
    expect(agentEnd.status).toBe("error");

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

    expect(session.state).toBe("done");
    session.dispose();
  });

  test("autoCompact triggers when messages exceed keepRecent", async () => {
    const cp = inMemoryCheckpointer();
    // Pre-load 10 messages to push past keepRecent threshold
    await cp.save("ac-test", [
      ...Array.from({ length: 10 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        text: `message ${i}`.repeat(5), // pad to make compaction worthwhile
      })),
    ]);

    const session = new AgentSession({
      model: echoModel("ok"),
      sessionId: "ac-test",
      checkpointer: cp,
      compaction: { autoCompact: true, keepRecent: 2 },
    });

    const events: string[] = [];
    session.subscribe((e) => {
      events.push(e.type);
    });

    await session.prompt("hi");

    expect(events).toContain("compaction_start");
    expect(events).toContain("compaction_end");
    // After compaction, messages reduced (summary + keepRecent)
    const usage = session.getContextUsage();
    expect(usage!.messageCount).toBeLessThanOrEqual(3); // summary + 2 recent
    session.dispose();
  });
});

function blockingModel(): ChatModel {
  return {
    id: "blocking",
    async *stream(_msgs, opts): AsyncIterable<AIMessageChunk> {
      yield { delta: { type: "text", text: "working..." } };
      // Block indefinitely until aborted — keeps state "running"
      await new Promise<void>((resolve) => {
        opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
}

describe("AgentSession — steer/followUp", () => {
  test("steer throws when agent not running", () => {
    const session = new AgentSession({ model: echoModel("x") });
    expect(() => session.steer("hey")).toThrow();
    session.dispose();
  });

  test("steer enqueues and emits queue_update when running", async () => {
    const session = new AgentSession({ model: blockingModel() });
    const events: string[] = [];
    session.subscribe((e) => {
      if (e.type === "queue_update") events.push("queue");
    });
    // Start prompt (doesn't block — runs in event loop)
    const promptP = session.prompt("hi");
    // Give it a tick to enter running state
    await new Promise((r) => setTimeout(r, 10));
    expect(session.state).toBe("running");
    session.steer("turn left");
    expect(events).toContain("queue");
    session.abort();
    await promptP.catch(() => {});
    session.dispose();
  });

  test("followUp enqueues when agent is initialized", async () => {
    const session = new AgentSession({ model: echoModel("ok") });
    await session.prompt("hi");
    const events: string[] = [];
    session.subscribe((e) => {
      if (e.type === "queue_update") events.push("queue");
    });
    session.followUp("next task");
    expect(events).toContain("queue");
    session.dispose();
  });

  test("prompt during running routes to steer", async () => {
    const session = new AgentSession({ model: blockingModel() });
    const events: string[] = [];
    session.subscribe((e) => {
      if (e.type === "queue_update") events.push("queue");
    });
    const p = session.prompt("hi");
    await new Promise((r) => setTimeout(r, 10));
    session.prompt("second message");
    expect(events).toContain("queue");
    session.abort();
    await p.catch(() => {});
    session.dispose();
  });

  test("dispose clears steer/followUp queues", async () => {
    const session = new AgentSession({ model: echoModel("x") });
    await session.prompt("init");
    session.followUp("next");
    session.dispose();
    expect(session.state).toBe("idle");
  });

  test("does NOT trigger extra finalization from steer", async () => {
    const session = new AgentSession({ model: echoModel("ok") });
    const agentEnds: string[] = [];
    session.subscribe((e) => {
      if (e.type === "agent_end") agentEnds.push("agent_end");
    });
    await session.prompt("hi");
    expect(agentEnds.length).toBe(1);
    session.dispose();
  });
});
// ─── Plugin init callback tests ───────────────────────────

function scriptedModel(
  turns: Array<
    { type: "text"; text: string } | { type: "tool_call"; id: string; name: string; input: unknown }
  >,
): ChatModel {
  return {
    id: "scripted",
    async *stream(messages: readonly Message[]): AsyncIterable<AIMessageChunk> {
      const turn = messages.filter((m) => m.role === "assistant").length;
      const item = turns[Math.min(turn, turns.length - 1)];
      if (!item) return;
      if (item.type === "text") {
        yield { delta: { type: "text", text: item.text } };
        yield { done: true, stopReason: "end_turn" };
      } else {
        yield { delta: { type: "tool_use", id: item.id, name: item.name } };
        yield {
          delta: {
            type: "input_json_delta",
            id: item.id,
            partial_json: JSON.stringify(item.input),
          },
        };
        yield { done: true, stopReason: "tool_use" };
      }
    },
  };
}

describe("AgentSession - plugin init", () => {
  test("plugin with init callback registers tools dynamically", async () => {
    let toolCalled = false;
    const dynamicTool: Tool = {
      name: "dynamic_lookup",
      description: "A tool registered at init time",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      execute: () => {
        toolCalled = true;
        return { content: "dynamic result" };
      },
    };

    const plugin = definePlugin({
      name: "dynamic",
      hooks: {},
      init: (api) => {
        api.registerTools([dynamicTool]);
      },
    });

    const session = new AgentSession({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "dynamic_lookup", input: { q: "test" } },
        { type: "text", text: "done" },
      ]),
      plugins: [plugin],
    });

    await session.prompt("use the dynamic tool");

    expect(toolCalled).toBe(true);
    expect(session.state).toBe("done");
    session.dispose();
  });

  test("plugin without init works unchanged", async () => {
    const plugin = definePlugin({
      name: "static",
      hooks: {},
      tools: [
        {
          name: "static_tool",
          description: "",
          inputSchema: {},
          execute: () => ({ content: "static ok" }),
        },
      ],
    });

    const session = new AgentSession({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "static_tool", input: {} },
        { type: "text", text: "ok" },
      ]),
      plugins: [plugin],
    });

    await session.prompt("call the static tool");

    expect(session.state).toBe("done");
    session.dispose();
  });
});
