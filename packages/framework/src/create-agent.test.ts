import { describe, expect, test } from "bun:test";
import type { AIMessageChunk, ChatModel, ContentBlock, Message, Tool } from "@my-agent-team/core";
import { createAgent } from "./create-agent.js";
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

describe("createAgent", () => {
  test("single-turn text → run yields assistant message and appends to thread", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "hello" }]),
    });

    const yielded = await collect(agent.run("hi"));

    expect(yielded).toEqual([{ role: "assistant", content: [{ type: "text", text: "hello" }] }]);
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
    const agent = await createAgent({ model: scriptedModel([{ type: "text", text: "hi" }]) });

    await collect(agent.run("first"));
    const forked = agent.fork();

    expect(forked.thread.id).not.toBe(agent.thread.id);
    // fork() defaults to structuredClone of current thread.messages
    expect(forked.thread.messages).toHaveLength(2);
    expect(forked.thread.messages).toEqual(agent.thread.messages);
    expect(forked.thread.messages).not.toBe(agent.thread.messages); // deep clone
  });

  test("parallel fork does not interfere with original", async () => {
    const agent = await createAgent({ model: scriptedModel([{ type: "text", text: "ok" }]) });

    const forked = agent.fork();
    await collect(forked.run("fork-msg"));

    // forked has 2 messages (user + assistant), original is empty
    expect(forked.thread.messages).toHaveLength(2);
    expect(agent.thread.messages).toHaveLength(0);
  });

  test("aborts early: signal already aborted does not push user message", async () => {
    const agent = await createAgent({ model: scriptedModel([{ type: "text", text: "ok" }]) });
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
        { name: "lookup", description: "", inputSchema: {}, execute: () => ({ content: "ok" }) },
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
    // Use a never-returning model so the first run stays active
    const agent = await createAgent({
      model: {
        // eslint-disable-next-line require-yield
        async *stream() {
          // never actually yields — loop stays in progress
          await new Promise(() => {});
        },
      },
    });

    // First run starts and stays active (never-returning model)
    void collect(agent.run("one"));

    // Second call should throw immediately
    await expect(collect(agent.run("two"))).rejects.toThrow("already running");
  });

  test("beforeTool plain skip without result", async () => {
    let toolExecuted = false;

    const agent = await createAgent({
      model: scriptedModel([
        { type: "tool_call", id: "t1", name: "blocked", input: {} },
        { type: "text", text: "ok" },
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
      plugins: [definePlugin({ name: "skip", hooks: { beforeTool: () => ({ skip: true }) } })],
    });

    await collect(agent.run("do it"));

    expect(toolExecuted).toBe(false);
    const resultMsg = agent.thread.messages.find(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
    );
    const block = (resultMsg?.content as ContentBlock[])[0];
    expect(block).toMatchObject({ type: "tool_result", content: "Tool skipped" });
    expect((block as { is_error?: boolean }).is_error).toBeUndefined();
  });

  test("beforeModel plugin transforms messages", async () => {
    const plugin = definePlugin({
      name: "truncate",
      hooks: {
        beforeModel: (_, msgs) => msgs.slice(-2),
      },
    });

    const agent = await createAgent({
      model: scriptedModel([{ type: "text", text: "ok" }]),
      plugins: [plugin],
    });

    await collect(agent.run("hi"));

    // thread.messages has all 2 (user+assistant), but model only saw the last 2
    expect(agent.thread.messages).toHaveLength(2);
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
        { name: "log", description: "", inputSchema: {}, execute: () => ({ content: "done" }) },
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

    // should not throw
    await collect(agent.run("hi"));
    expect(agent.thread.messages).toHaveLength(2);
  });

  test("maxSteps stops infinite tool loop", async () => {
    const agent = await createAgent({
      model: scriptedModel([{ type: "tool_call", id: "t1", name: "loop", input: {} }]),
      tools: [
        { name: "loop", description: "", inputSchema: {}, execute: () => ({ content: "again" }) },
      ],
    });

    const yielded = await collect(agent.run("go", { maxSteps: 2 }));

    // 2 steps: user+assistant(tool)+user(result)+assistant(tool)+user(result) = 5 messages yielded
    expect(agent.thread.messages).toHaveLength(5);
    // yielded messages: ass(tool), user(result), ass(tool), user(result)
    expect(yielded.filter((m) => m.role === "user" && Array.isArray(m.content))).toHaveLength(2);
  });
});
