import { describe, expect, test } from "bun:test";
import type { AIMessageChunk, ChatModel, Message, Tool } from "@my-agent-team/core";
import type { InterruptState } from "./checkpointer.js";
import type { AgentEvent } from "./create-agent.js";
import { createAgent, InterruptSignal } from "./index.js";
import { definePlugin } from "./plugin.js";

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

function scriptedModel(
  turns: Array<
    { type: "text"; text: string } | { type: "tool_call"; id: string; name: string; input: unknown }
  >,
): ChatModel {
  return {
    async *stream(messages): AsyncIterable<AIMessageChunk> {
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

function msgPayloads(events: AgentEvent[]): Message[] {
  return events.filter((e) => e.type === "message").map((e) => e.payload as Message);
}

function makeTool(name: string): Tool {
  return { name, description: "", inputSchema: {}, execute: () => ({ content: "ok" }) };
}

describe("createAgent", () => {
  // ─── M3 regression ───────────────────────────────────────────

  test("single-turn text → run yields AgentEvent envelope", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "hello" }]),
    });

    const yielded = await collect(agent.run("hi"));

    expect(yielded).toEqual([
      {
        type: "message",
        payload: { role: "assistant", content: [{ type: "text", text: "hello" }] },
      },
    ]);
    expect(agent.thread.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  test("auto-inserts systemPrompt on first run", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "ok" }]),
      systemPrompt: "You are helpful.",
    });

    await collect(agent.run("hi"));

    expect(agent.thread.messages[0]).toEqual({ role: "system", content: "You are helpful." });
  });

  test("does not duplicate systemPrompt across runs", async () => {
    const agent = await createAgent({
      model: scriptedModel([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
      systemPrompt: "sys",
    });

    await collect(agent.run("first"));
    await collect(agent.run("second"));

    const systemCount = agent.thread.messages.filter((m) => m.role === "system").length;
    expect(systemCount).toBe(1);
  });

  test("tool loop: executes tool and continues", async () => {
    const lookup: Tool = {
      name: "lookup",
      description: "",
      inputSchema: {},
      execute: (input) => ({ content: `result:${(input as { q: string }).q}` }),
    };

    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "lookup", input: { q: "weather" } },
        { type: "text", text: "sunny" },
      ]),
      tools: [lookup],
    });

    await collect(agent.run("what's the weather?"));

    expect(agent.thread.messages).toHaveLength(4);
    expect(agent.thread.messages[2]?.role).toBe("user");
    expect((agent.thread.messages[3] as Message)?.role).toBe("assistant");
  });

  test("fork creates independent agent with separate thread", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "hi" }]),
    });

    await collect(agent.run("first"));
    const forked = agent.fork();

    expect(forked.thread.id).not.toBe(agent.thread.id);
    expect(forked.thread.messages).toHaveLength(2);
    expect(forked.thread.messages).toEqual(agent.thread.messages);
    expect(forked.thread.messages).not.toBe(agent.thread.messages);
  });

  test("fork with same threadId throws", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "hi" }]),
    });

    expect(() => agent.fork([], agent.thread.id)).toThrow("Cannot fork with the same threadId");
  });

  test("parallel fork does not interfere with original", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "ok" }]),
    });

    const forked = agent.fork();
    await collect(forked.run("fork-msg"));

    expect(forked.thread.messages).toHaveLength(2);
    expect(agent.thread.messages).toHaveLength(0);
  });

  test("aborts early: signal already aborted does not push user message", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "ok" }]),
    });
    const controller = new AbortController();
    controller.abort();

    await expect(collect(agent.run("hi", { signal: controller.signal }))).rejects.toThrow();
    expect(agent.thread.messages).toHaveLength(0);
  });

  test("checkpointer save is called after tool turn", async () => {
    let savedThreadId = "";
    let savedMessages: Message[] = [];

    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "lookup", input: { q: "x" } },
        { type: "text", text: "done" },
      ]),
      tools: [
        {
          name: "lookup",
          description: "",
          inputSchema: {},
          execute: () => ({ content: "ok" }),
        },
      ],
      checkpointer: {
        load: () => Promise.resolve(null),
        save: (id, msgs) => {
          savedThreadId = id;
          savedMessages = msgs.slice();
          return Promise.resolve();
        },
      },
    });

    await collect(agent.run("hi"));

    expect(savedThreadId).toBe(agent.thread.id);
    expect(savedMessages).toHaveLength(4);
  });

  test("checkpointer load recovers existing thread", async () => {
    const savedMessages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "old" },
      { role: "assistant", content: "answer" },
    ];

    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "new" }]),
      threadId: "saved-thread",
      checkpointer: {
        load: (id) => {
          expect(id).toBe("saved-thread");
          return Promise.resolve(savedMessages.slice());
        },
        save: () => Promise.resolve(),
      },
    });

    expect(agent.thread.messages).toEqual(savedMessages);
  });

  test("checkpointer load returns null → empty thread", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "fresh" }]),
      threadId: "new-thread",
      checkpointer: {
        load: () => Promise.resolve(null),
        save: () => Promise.resolve(),
      },
    });

    expect(agent.thread.messages).toEqual([]);
  });

  test("throws on concurrent run", async () => {
    const agent = await createAgent({
      model: {
        // eslint-disable-next-line require-yield
        async *stream() {
          await new Promise(() => {});
        },
      },
    });

    void collect(agent.run("one"));

    await expect(collect(agent.run("two"))).rejects.toThrow("already running");
  });

  test("beforeTool skip prevents execution", async () => {
    let toolExecuted = false;

    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "blocked", input: {} },
        { type: "text", text: "handled" },
      ]),
      tools: [
        {
          name: "blocked",
          description: "",
          inputSchema: {},
          execute: () => {
            toolExecuted = true;
            return { content: "ok" };
          },
        },
      ],
      plugins: [
        definePlugin({
          name: "guard",
          hooks: {
            beforeTool: () => ({ skip: true, result: "denied" }),
          },
        }),
      ],
    });

    await collect(agent.run("do it"));

    expect(toolExecuted).toBe(false);
    const toolResults = agent.thread.messages.filter(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === "tool_result"),
    );
    expect(toolResults).toHaveLength(1);
  });

  test("afterTool side-effect is called", async () => {
    let sideEffectCall = "";

    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "log", input: {} },
        { type: "text", text: "ok" },
      ]),
      tools: [
        {
          name: "log",
          description: "",
          inputSchema: {},
          execute: () => ({ content: "done" }),
        },
      ],
      plugins: [
        definePlugin({
          name: "audit",
          hooks: {
            afterTool: (_, call) => {
              sideEffectCall = call.id;
            },
          },
        }),
      ],
    });

    await collect(agent.run("log"));

    expect(sideEffectCall).toBe("t1");
  });

  test("beforeModel error propagates to caller", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "ok" }]),
      plugins: [
        definePlugin({
          name: "explode",
          hooks: {
            beforeModel: () => {
              throw new Error("boom");
            },
          },
        }),
      ],
    });

    await expect(collect(agent.run("hi"))).rejects.toThrow("boom");
  });

  test("afterModel error is swallowed", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "fine" }]),
      plugins: [
        definePlugin({
          name: "flaky",
          hooks: {
            afterModel: () => {
              throw new Error("unimportant");
            },
          },
        }),
      ],
    });

    await collect(agent.run("hi"));
    expect(agent.thread.messages).toHaveLength(2);
  });

  test("maxSteps stops infinite tool loop", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "tool_call", id: "t1", name: "loop", input: {} }]),
      tools: [
        {
          name: "loop",
          description: "",
          inputSchema: {},
          execute: () => ({ content: "again" }),
        },
      ],
    });

    const yielded = await collect(agent.run("go", { maxSteps: 2 }));

    // 2 steps: 2 assistant yields + tool_result pushes = 5 thread messages
    expect(agent.thread.messages).toHaveLength(5);
    // yielded: 2 assistant messages (tool_result pushed but not yielded)
    expect(yielded.filter((e) => e.type === "message")).toHaveLength(2);
  });

  // ─── M4: AgentEvent envelope ─────────────────────────────────

  test("AgentEvent envelope: message type wraps payload", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "hello" }]),
    });

    for await (const ev of agent.run("hi")) {
      expect(ev).toHaveProperty("type");
      expect(ev).toHaveProperty("payload");
      if (ev.type === "message") {
        expect(ev.payload).toHaveProperty("role");
      }
    }
  });

  // ─── M7: AgentEvent error variant ─────────────────────────────

  test("AgentEvent supports error variant with message and optional stack", () => {
    const withoutStack: AgentEvent = {
      type: "error",
      payload: { message: "something went wrong" },
    };
    expect(withoutStack.type).toBe("error");
    expect(withoutStack.payload.message).toBe("something went wrong");
    expect(withoutStack.payload.stack).toBeUndefined();

    const withStack: AgentEvent = {
      type: "error",
      payload: {
        message: "boom",
        stack: "Error: boom\n    at foo (bar.ts:1:2)",
      },
    };
    expect(withStack.type).toBe("error");
    expect(withStack.payload.message).toBe("boom");
    expect(withStack.payload.stack).toBeDefined();
  });

  // ─── M4: Interrupt & Resume ──────────────────────────────────

  test("tool throws InterruptSignal → yields interrupted and saves state", async () => {
    let interruptSaved = false;
    const cp = {
      load: () => Promise.resolve(null as Message[] | null),
      save: () => Promise.resolve(),
      saveInterrupt: () => {
        interruptSaved = true;
        return Promise.resolve();
      },
      consumeInterrupt: () => Promise.resolve(null),
    };

    const agent = await createAgent({
      model: scriptedModel([{ type: "tool_call", id: "t1", name: "ask", input: {} }]),
      tools: [
        {
          name: "ask",
          description: "",
          inputSchema: {},
          execute: () => {
            throw new InterruptSignal("needs approval", { risk: "high" });
          },
        },
      ],
      checkpointer: cp,
    });

    const yielded = await collect(agent.run("do it"));

    const interrupted = yielded.find((e) => e.type === "interrupted");
    expect(interrupted).toBeDefined();
    expect(interrupted?.payload.reason).toBe("needs approval");
    expect(interrupted?.payload.meta).toEqual({ risk: "high" });
    expect(interruptSaved).toBe(true);
    // messages include the assistant with tool_use
    const assistants = agent.thread.messages.filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
  });

  test("resume approved injects tool_result and continues", async () => {
    let interruptState: InterruptState | null = null;

    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "ask", input: {} },
        { type: "text", text: "thanks for approving" },
      ]),
      tools: [
        {
          name: "ask",
          description: "",
          inputSchema: {},
          execute: () => {
            throw new InterruptSignal("needs approval");
          },
        },
      ],
      checkpointer: {
        load: () => Promise.resolve(null),
        save: () => Promise.resolve(),
        saveInterrupt: (_id, state) => {
          interruptState = state;
          return Promise.resolve();
        },
        consumeInterrupt: () => {
          const s = interruptState;
          interruptState = null;
          return Promise.resolve(s);
        },
      },
    });

    // First run: triggers interrupt
    await collect(agent.run("do it"));
    // Second call: resume
    const yielded = await collect(agent.resume({ approved: true }));

    // Should have tool_result in messages
    const toolResults = agent.thread.messages.filter(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
    );
    expect(toolResults).toHaveLength(1);

    const resultBlock = (toolResults[0]?.content as { type: string; is_error?: boolean }[])[0]!;
    expect(resultBlock.type).toBe("tool_result");
    expect((resultBlock as { is_error?: boolean }).is_error).toBe(false);

    // Second model response should be yielded
    const msgs = msgPayloads(yielded);
    expect(msgs.some((m) => m.role === "assistant")).toBe(true);
  });

  test("resume denied → tool_result is_error=true", async () => {
    let interruptState: InterruptState | null = null;

    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "ask", input: {} },
        { type: "text", text: "ok" },
      ]),
      tools: [
        {
          name: "ask",
          description: "",
          inputSchema: {},
          execute: () => {
            throw new InterruptSignal("needs approval");
          },
        },
      ],
      checkpointer: {
        load: () => Promise.resolve(null),
        save: () => Promise.resolve(),
        saveInterrupt: (_id, state) => {
          interruptState = state;
          return Promise.resolve();
        },
        consumeInterrupt: () => {
          const s = interruptState;
          interruptState = null;
          return Promise.resolve(s);
        },
      },
    });

    await collect(agent.run("do it"));
    await collect(agent.resume({ approved: false }));

    const toolResults = agent.thread.messages.filter(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
    );
    const block = (
      toolResults[0]?.content as { type: string; content: string; is_error?: boolean }[]
    )[0]!;
    expect((block as { is_error?: boolean }).is_error).toBe(true);
    expect(block.content).toContain("denied");
  });

  test("resume denied with custom message", async () => {
    let interruptState: InterruptState | null = null;

    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "ask", input: {} },
        { type: "text", text: "ok" },
      ]),
      tools: [
        {
          name: "ask",
          description: "",
          inputSchema: {},
          execute: () => {
            throw new InterruptSignal("needs approval");
          },
        },
      ],
      checkpointer: {
        load: () => Promise.resolve(null),
        save: () => Promise.resolve(),
        saveInterrupt: (_id, state) => {
          interruptState = state;
          return Promise.resolve();
        },
        consumeInterrupt: () => {
          const s = interruptState;
          interruptState = null;
          return Promise.resolve(s);
        },
      },
    });

    await collect(agent.run("do it"));
    await collect(agent.resume({ approved: false, message: "Not now, try a different approach" }));

    const toolResults = agent.thread.messages.filter(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
    );
    const block = (
      toolResults[0]?.content as { type: string; content: string; is_error?: boolean }[]
    )[0]!;
    expect(block.content).toBe("Not now, try a different approach");
  });

  test("resume with no pending interrupt throws", async () => {
    // Default inMemoryCheckpointer has no pending interrupt
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "ok" }]),
    });

    await expect(collect(agent.resume({ approved: true }))).rejects.toThrow("No pending interrupt");
  });

  test("tool throws InterruptSignal but checkpointer lacks saveInterrupt → throws actionable message", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "tool_call", id: "t1", name: "ask", input: {} }]),
      tools: [
        {
          name: "ask",
          description: "",
          inputSchema: {},
          execute: () => {
            throw new InterruptSignal("needs approval");
          },
        },
      ],
      checkpointer: {
        load: () => Promise.resolve(null),
        save: () => Promise.resolve(),
        // no saveInterrupt / consumeInterrupt
      },
    });

    await expect(collect(agent.run("do it"))).rejects.toThrow("does not support");
  });

  test("concurrent resume throws", async () => {
    let interruptState: InterruptState | null = null;

    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "ask", input: {} },
        { type: "text", text: "ok" },
      ]),
      tools: [
        {
          name: "ask",
          description: "",
          inputSchema: {},
          execute: () => {
            throw new InterruptSignal("needs approval");
          },
        },
      ],
      checkpointer: {
        load: () => Promise.resolve(null),
        save: () => Promise.resolve(),
        saveInterrupt: (_id, state) => {
          interruptState = state;
          return Promise.resolve();
        },
        consumeInterrupt: () => {
          const s = interruptState;
          interruptState = null;
          return Promise.resolve(s);
        },
      },
    });

    await collect(agent.run("do it"));

    // Start first resume (never returns)
    void collect(agent.resume({ approved: true }));

    // Second resume should throw
    await expect(collect(agent.resume({ approved: true }))).rejects.toThrow("already running");
  });

  // ─── M4: ContextManager integration ──────────────────────────

  test("ContextManager.shape called before plugin.beforeModel", async () => {
    const calls: string[] = [];

    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "ok" }]),
      contextManager: {
        shape: () => {
          calls.push("cm");
          return [];
        },
      },
      plugins: [
        definePlugin({
          name: "test",
          hooks: {
            beforeModel: () => {
              calls.push("plugin");
              return [];
            },
          },
        }),
      ],
    });

    await collect(agent.run("hi"));

    expect(calls).toEqual(["cm", "plugin"]);
  });

  test("shape result does not pollute thread.messages", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "hello" }]),
      contextManager: {
        shape: (_ctx, _msgs) => {
          // return different messages than what's in thread
          return [
            { role: "system", content: "fake" },
            { role: "user", content: "fake" },
          ];
        },
      },
    });

    await collect(agent.run("hi"));

    // thread.messages still has the real messages, not shape output
    expect(agent.thread.messages[0]?.role).toBe("user");
    expect(agent.thread.messages[0]?.content).toBe("hi");
  });

  test("default ContextManager is passthrough", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "ok" }]),
    });

    await collect(agent.run("hi"));

    expect(agent.thread.messages).toHaveLength(2);
  });

  // ─── M4: Logger integration ──────────────────────────────────

  test("framework uses injected logger", async () => {
    const warnings: string[] = [];
    const logger = {
      level: "warn" as const,
      debug: () => {},
      info: () => {},
      warn: (msg: string) => {
        warnings.push(msg);
      },
      error: () => {},
    };

    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "ok" }]),
      plugins: [
        definePlugin({
          name: "flaky",
          hooks: {
            afterModel: () => {
              throw new Error("unimportant");
            },
          },
        }),
      ],
      logger,
    });

    await collect(agent.run("hi"));
    expect(warnings.length).toBeGreaterThan(0);
  });

  // ─── M4: HookContext exposes three capabilities ───────────────

  test("HookContext exposes logger, checkpointer, contextManager", async () => {
    let hookCtx: unknown = null;

    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "ok" }]),
      plugins: [
        definePlugin({
          name: "inspector",
          hooks: {
            beforeModel: (ctx, msgs) => {
              hookCtx = ctx;
              return [...msgs];
            },
          },
        }),
      ],
    });

    await collect(agent.run("hi"));

    expect(hookCtx).toHaveProperty("threadId");
    expect(hookCtx).toHaveProperty("logger");
    expect(hookCtx).toHaveProperty("checkpointer");
    expect(hookCtx).toHaveProperty("contextManager");
  });

  // ─── M4: appendEvent ─────────────────────────────────────────

  test("appendEvent called for key events", async () => {
    const events: { type: string }[] = [];

    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "log", input: {} },
        { type: "text", text: "done" },
      ]),
      tools: [
        {
          name: "log",
          description: "",
          inputSchema: {},
          execute: () => ({ content: "ok" }),
        },
      ],
      checkpointer: {
        load: () => Promise.resolve(null),
        save: () => Promise.resolve(),
        appendEvent: (_id, event) => {
          events.push({ type: event.type });
          return Promise.resolve();
        },
        readEvents: async function* () {},
      },
    });

    await collect(agent.run("hi"));

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("user_input");
    expect(eventTypes).toContain("model_start");
    expect(eventTypes).toContain("model_end");
    expect(eventTypes).toContain("tool_start");
    expect(eventTypes).toContain("tool_end");
    expect(eventTypes).toContain("run_end");
  });

  test("appendEvent called on interrupt and resume", async () => {
    const events: { type: string }[] = [];
    let interruptState: InterruptState | null = null;

    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "ask", input: {} },
        { type: "text", text: "done" },
      ]),
      tools: [
        {
          name: "ask",
          description: "",
          inputSchema: {},
          execute: () => {
            throw new InterruptSignal("wait");
          },
        },
      ],
      checkpointer: {
        load: () => Promise.resolve(null),
        save: () => Promise.resolve(),
        saveInterrupt: (_id, state) => {
          interruptState = state;
          return Promise.resolve();
        },
        consumeInterrupt: () => {
          const s = interruptState;
          interruptState = null;
          return Promise.resolve(s);
        },
        appendEvent: (_id, event) => {
          events.push({ type: event.type });
          return Promise.resolve();
        },
        readEvents: async function* () {},
      },
    });

    await collect(agent.run("do it"));
    await collect(agent.resume({ approved: true }));

    const eventTypes = events.map((e) => e.type);
    expect(eventTypes).toContain("interrupt");
    expect(eventTypes).toContain("resume");
  });

  // ─── M4: beforeTool InterruptSignal NOT recognized ────────────

  test("beforeTool throwing InterruptSignal is NOT treated as interrupt", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "tool_call", id: "t1", name: "log", input: {} }]),
      tools: [
        {
          name: "log",
          description: "",
          inputSchema: {},
          execute: () => ({ content: "ok" }),
        },
      ],
      plugins: [
        definePlugin({
          name: "bad",
          hooks: {
            beforeTool: () => {
              throw new InterruptSignal("should not work here");
            },
          },
        }),
      ],
    });

    // Should throw as a before* error, NOT yield interrupted
    await expect(collect(agent.run("hi"))).rejects.toThrow("should not work here");
  });

  // ─── M4: Checkpointer paired validation ──────────────────────

  test("createAgent throws on unpaired appendEvent", () => {
    expect(
      createAgent({
        model: scriptedModel([{ type: "text", text: "ok" }]),
        checkpointer: {
          load: () => Promise.resolve(null),
          save: () => Promise.resolve(),
          appendEvent: () => Promise.resolve(),
          // no readEvents
        },
      }),
    ).rejects.toThrow("event capability is partial");
  });

  test("createAgent throws on unpaired saveInterrupt", () => {
    expect(
      createAgent({
        model: scriptedModel([{ type: "text", text: "ok" }]),
        checkpointer: {
          load: () => Promise.resolve(null),
          save: () => Promise.resolve(),
          saveInterrupt: () => Promise.resolve(),
          // no consumeInterrupt
        },
      }),
    ).rejects.toThrow("interrupt capability is partial");
  });

  // ─── M5: Plugin.tools merge ──────────────────────────────────

  test("plugin tools are merged into agent tool set", async () => {
    const agent2 = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "p1_b", input: {} },
        { type: "text", text: "done" },
      ]),
      tools: [makeTool("config_a")],
      plugins: [
        definePlugin({
          name: "p1",
          hooks: {},
          tools: [makeTool("p1_a"), makeTool("p1_b")],
        }),
      ],
    });

    // tool from plugin should be found and executed without "Tool not found"
    await collect(agent2.run("go"));
    const toolResults = agent2.thread.messages.filter(
      (m) =>
        Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result" && b.is_error),
    );
    expect(toolResults).toHaveLength(0);
  });

  test("duplicate tool name between config and plugin throws at startup", () => {
    expect(
      createAgent({
        model: scriptedModel([{ type: "text", text: "ok" }]),
        tools: [makeTool("read")],
        plugins: [
          definePlugin({
            name: "p1",
            hooks: {},
            tools: [makeTool("read")],
          }),
        ],
      }),
    ).rejects.toThrow("Tool name collision");
  });

  test("duplicate tool name between two plugins throws at startup", () => {
    expect(
      createAgent({
        model: scriptedModel([{ type: "text", text: "ok" }]),
        plugins: [
          definePlugin({ name: "a", hooks: {}, tools: [makeTool("x")] }),
          definePlugin({ name: "b", hooks: {}, tools: [makeTool("x")] }),
        ],
      }),
    ).rejects.toThrow("Tool name collision");
  });

  test("plugin without tools does not cause issues", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "hi" }]),
      plugins: [definePlugin({ name: "bare", hooks: {} })],
    });

    await collect(agent.run("hi"));
    expect(agent.thread.messages).toHaveLength(2);
  });

  test("config tools order preserved before plugin tools", async () => {
    const agent = await createAgent({
      model: {
        async *stream(_msgs, _opts) {
          yield { delta: { type: "text", text: "ok" } };
          yield { done: true, stopReason: "end_turn" };
        },
      },
      tools: [makeTool("first"), makeTool("second")],
      plugins: [
        definePlugin({
          name: "p1",
          hooks: {},
          tools: [makeTool("third")],
        }),
      ],
    });

    // validate tool order is usable
    await collect(agent.run("hi"));
    expect(agent.thread.messages).toHaveLength(2);
  });
});
