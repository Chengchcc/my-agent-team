import { describe, expect, test } from "bun:test";
import type { AIMessageChunk, ChatModel, Tool } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";
import type { AgentRuntime } from "./agent-options.js";
import { consoleLogger, inMemoryCheckpointer, passthroughContextManager } from "./index.js";
import { createPluginRunner } from "./plugin-runner.js";
import { runLoop } from "./run-loop.js";

function makeRt(opts: { tools?: Tool[]; messages?: Message[] } = {}): AgentRuntime {
  const tools = opts.tools ?? [];
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const checkpointer = inMemoryCheckpointer();
  const logger = consoleLogger({ level: "silent" });
  return {
    thread: { id: "t1", messages: opts.messages ?? [] },
    plugins: createPluginRunner(
      [],
      {
        threadId: "t1",
        signal: undefined,
        logger,
        checkpointer,
        contextManager: passthroughContextManager(),
        emit: () => {},
      },
      logger,
    ),
    toolMap,
    checkpointer,
    contextManager: passthroughContextManager(),
    logger,
    model: { id: "test", stream: async function* () {}, countTokens: async () => 0 },
    tools,
    pendingEvents: [],
    save: async () => {},
    runId: "run-1",
    toolStates: [],
    assistantBlocks: [],
  };
}

function toolUseModel(calls: Array<{ id: string; name: string; input?: unknown }>): ChatModel {
  return {
    id: "test-model",
    stream: async function* (): AsyncGenerator<AIMessageChunk> {
      yield {
        delta: { type: "text", text: "Let me use tools." },
        usage: { input: 10, output: 5 },
      };
      for (const c of calls) {
        yield {
          delta: {
            type: "tool_use",
            id: c.id,
            name: c.name,
            input: JSON.stringify(c.input ?? {}),
          },
          usage: { input: 10, output: 5 },
        };
      }
      yield {
        delta: { type: "text", text: "" },
        stopReason: "tool_use",
        done: true,
        usage: { input: 10, output: 10 },
      };
    },
    countTokens: async () => 0,
  };
}

describe("runLoop tool parallel execution", () => {
  test("serial tools execute in order via executeOne path", async () => {
    const calls: string[] = [];
    const t1: Tool = {
      name: "t1",
      description: "",
      inputSchema: {},
      executionMode: "serial",
      execute: async () => {
        calls.push("t1");
        return { content: "ok" };
      },
    };
    const t2: Tool = {
      name: "t2",
      description: "",
      inputSchema: {},
      executionMode: "serial",
      execute: async () => {
        calls.push("t2");
        return { content: "ok" };
      },
    };

    const rt = makeRt({ tools: [t1, t2] });
    rt.model = toolUseModel([
      { id: "c1", name: "t1" },
      { id: "c2", name: "t2" },
    ]);

    for await (const ev of runLoop(rt, { maxSteps: 1 })) {
    }

    expect(calls).toEqual(["t1", "t2"]);
  });

  test("concurrent tools run in parallel (timing check)", async () => {
    const starts: number[] = [];
    const ends: number[] = [];

    const slow: Tool = {
      name: "slow",
      description: "",
      inputSchema: {},
      executionMode: "concurrent",
      execute: async () => {
        starts.push(Date.now());
        await new Promise((r) => setTimeout(r, 100));
        ends.push(Date.now());
        return { content: "done" };
      },
    };

    const rt = makeRt({ tools: [slow] });
    rt.model = toolUseModel([
      { id: "c1", name: "slow" },
      { id: "c2", name: "slow" },
    ]);

    for await (const ev of runLoop(rt, { maxSteps: 1 })) {
    }

    expect(starts.length).toBe(2);
    expect(ends.length).toBe(2);
    // Both started before either ended = parallel
    expect(Math.max(starts[0]!, starts[1]!)).toBeLessThan(Math.min(ends[0]!, ends[1]!));
  });

  test("tool_results written in tool_use order, not completion order", async () => {
    const t1: Tool = {
      name: "t1",
      description: "",
      inputSchema: {},
      executionMode: "concurrent",
      execute: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { content: "t1-result" };
      },
    };
    const t2: Tool = {
      name: "t2",
      description: "",
      inputSchema: {},
      executionMode: "concurrent",
      execute: async () => {
        return { content: "t2-result" };
      },
    };

    const rt = makeRt({ tools: [t1, t2] });
    rt.model = toolUseModel([
      { id: "c1", name: "t1" },
      { id: "c2", name: "t2" },
    ]);

    for await (const ev of runLoop(rt, { maxSteps: 1 })) {
    }

    const results = rt.thread.messages.filter(
      (m) => Array.isArray(m.blocks) && m.blocks.some((b: any) => b.type === "tool_result"),
    );
    expect(results.length).toBe(2);
    expect((results[0]!.blocks as any[])[0]!.tool_use_id).toBe("c1");
    expect((results[1]!.blocks as any[])[0]!.tool_use_id).toBe("c2");
  });

  test("mixed serial+concurrent → each serial gets own batch, concurrent grouped", async () => {
    const order: string[] = [];
    const s1: Tool = {
      name: "s1",
      description: "",
      inputSchema: {},
      executionMode: "serial",
      execute: async () => {
        order.push("s1");
        return { content: "ok" };
      },
    };
    const c1: Tool = {
      name: "c1",
      description: "",
      inputSchema: {},
      executionMode: "concurrent",
      execute: async () => {
        order.push("c1");
        return { content: "ok" };
      },
    };
    const c2: Tool = {
      name: "c2",
      description: "",
      inputSchema: {},
      executionMode: "concurrent",
      execute: async () => {
        order.push("c2");
        return { content: "ok" };
      },
    };
    const s2: Tool = {
      name: "s2",
      description: "",
      inputSchema: {},
      executionMode: "serial",
      execute: async () => {
        order.push("s2");
        return { content: "ok" };
      },
    };

    const rt = makeRt({ tools: [s1, c1, c2, s2] });
    rt.model = toolUseModel([
      { id: "sc1", name: "s1" },
      { id: "cc1", name: "c1" },
      { id: "cc2", name: "c2" },
      { id: "sc2", name: "s2" },
    ]);

    for await (const ev of runLoop(rt, { maxSteps: 1 })) {
    }

    const s1Idx = order.indexOf("s1");
    const s2Idx = order.indexOf("s2");
    const c1Idx = order.indexOf("c1");
    const c2Idx = order.indexOf("c2");
    // s1 must finish before c1/c2 start (its own batch)
    expect(s1Idx).toBeLessThan(Math.min(c1Idx, c2Idx));
    // s2 runs after c1/c2 (its own batch after concurrent batch)
    expect(s2Idx).toBeGreaterThan(Math.max(c1Idx, c2Idx));
  });
});
