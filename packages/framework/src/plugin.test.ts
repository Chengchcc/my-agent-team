import { describe, expect, test } from "bun:test";
import type { Message, ToolUseBlock } from "@my-agent-team/core";
import { inMemoryCheckpointer } from "./checkpointers/in-memory.js";
import { passthroughContextManager } from "./context-managers/passthrough.js";
import { consoleLogger } from "./logger.js";
import { definePlugin, type HookContext } from "./plugin.js";

function testCtx(overrides?: Partial<HookContext>): HookContext {
  return {
    threadId: "t1",
    logger: consoleLogger({ level: "silent" }),
    checkpointer: inMemoryCheckpointer(),
    contextManager: passthroughContextManager(),
    ...overrides,
  };
}

describe("definePlugin", () => {
  test("creates a plugin with the given name", () => {
    const plugin = definePlugin({
      name: "test-plugin",
      hooks: {},
    });

    expect(plugin.name).toBe("test-plugin");
    expect(plugin.hooks).toEqual({});
  });

  test("preserves hook functions", () => {
    const beforeModel = (_ctx: HookContext, msgs: readonly Message[]) => [...msgs];
    const afterModel = () => {};

    const plugin = definePlugin({
      name: "test",
      hooks: { beforeModel, afterModel },
    });

    expect(plugin.hooks.beforeModel).toBe(beforeModel);
    expect(plugin.hooks.afterModel).toBe(afterModel);
    expect(plugin.hooks.beforeTool).toBeUndefined();
    expect(plugin.hooks.afterTool).toBeUndefined();
  });

  test("passes ctx and messages to hooks", async () => {
    let capturedCtx: unknown;
    let capturedMsgs: unknown;

    const plugin = definePlugin({
      name: "capture",
      hooks: {
        afterModel(ctx, msgs) {
          capturedCtx = ctx;
          capturedMsgs = msgs;
        },
      },
    });

    const ctx = testCtx();
    const msgs: Message[] = [{ role: "user", content: "hi" }];
    await plugin.hooks.afterModel?.(ctx, msgs);

    expect(capturedCtx).toHaveProperty("threadId", "t1");
    expect(capturedCtx).toHaveProperty("logger");
    expect(capturedCtx).toHaveProperty("checkpointer");
    expect(capturedCtx).toHaveProperty("contextManager");
    expect(capturedMsgs).toBe(msgs);
  });

  test("HookContext exposes three capabilities", () => {
    const ctx = testCtx();
    expect(ctx.logger).toBeDefined();
    expect(ctx.checkpointer).toBeDefined();
    expect(ctx.contextManager).toBeDefined();
    expect(ctx.threadId).toBe("t1");
  });

  test("beforeTool returns undefined by default", async () => {
    const plugin = definePlugin({
      name: "passthrough",
      hooks: {
        beforeTool(_ctx, _call) {},
      },
    });

    const call: ToolUseBlock = { type: "tool_use", id: "t1", name: "read", input: {} };
    const result = await plugin.hooks.beforeTool?.(testCtx(), call, []);
    expect(result).toBeUndefined();
  });

  test("beforeTool can return skip with result", async () => {
    const plugin = definePlugin({
      name: "guard",
      hooks: {
        beforeTool() {
          return { skip: true, result: "not allowed" };
        },
      },
    });

    const call: ToolUseBlock = { type: "tool_use", id: "t1", name: "write", input: {} };
    const result = await plugin.hooks.beforeTool?.(testCtx(), call, []);

    expect(result).toEqual({ skip: true, result: "not allowed" });
  });
});
