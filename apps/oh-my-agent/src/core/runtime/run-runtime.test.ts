import { describe, expect, test } from "bun:test";
import type { Tool } from "@chengchenccc/message";
import { toPluginTool } from "./run-runtime.js";

/** The native→runtime adaptation is where an optional field goes missing
 *  without a single typecheck complaint: PluginTool is a separate
 *  declaration, so anything this function forgets to copy simply vanishes
 *  from the tool the loop actually sees. */
describe("toPluginTool", () => {
  test("carries the activity declaration and the other optionals through", () => {
    const native: Tool = {
      name: "bash",
      description: "run a command",
      inputSchema: { type: "object" },
      executionMode: "serial",
      describeStart: () => "正在执行：bun test",
      execute: () => ({ content: "ok" }),
    };
    const adapted = toPluginTool(native);
    expect(adapted.name).toBe("bash");
    expect(adapted.description).toBe("run a command");
    expect(adapted.inputSchema).toEqual({ type: "object" });
    expect(adapted.executionMode).toBe("serial");
    expect(adapted.describeStart?.({ command: "bun test" })).toBe("正在执行：bun test");
  });

  test("a tool without a declaration adapts with none (no invention)", () => {
    const native: Tool = {
      name: "mcp__github__create_issue",
      description: "create an issue",
      inputSchema: { type: "object" },
      execute: () => ({ content: "ok" }),
    };
    const adapted = toPluginTool(native);
    expect(adapted.describeStart).toBeUndefined();
  });

  test("the adapted execute normalizes a sync result", async () => {
    const native: Tool = {
      name: "sync",
      description: "sync tool",
      inputSchema: { type: "object" },
      execute: () => ({ content: "sync-result" }),
    };
    const result = await toPluginTool(native).execute({});
    expect(result).toEqual({ content: "sync-result" });
  });
});
