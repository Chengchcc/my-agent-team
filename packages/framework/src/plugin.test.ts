import { describe, expect, test } from "bun:test";
import type { Message, ToolUseBlock } from "@my-agent-team/core";
import { definePlugin, type HookContext } from "./plugin.js";

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

    const ctx: HookContext = { threadId: "t1" };
    const msgs: Message[] = [{ role: "user", content: "hi" }];
    await plugin.hooks.afterModel?.(ctx, msgs);

    expect(capturedCtx).toEqual({ threadId: "t1" });
    expect(capturedMsgs).toBe(msgs);
  });

  test("beforeTool returns undefined by default", async () => {
    const plugin = definePlugin({
      name: "passthrough",
      hooks: {
        beforeTool(_ctx, _call) {
          // no explicit return
        },
      },
    });

    const call: ToolUseBlock = { type: "tool_use", id: "t1", name: "read", input: {} };
    const result = await plugin.hooks.beforeTool?.({ threadId: "t" }, call, []);
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
    const result = await plugin.hooks.beforeTool?.({ threadId: "t" }, call, []);

    expect(result).toEqual({ skip: true, result: "not allowed" });
  });
});
