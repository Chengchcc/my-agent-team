import { describe, expect, test } from "bun:test";
import { consoleLogger } from "./console-logger.js";

describe("consoleLogger", () => {
  test("creates a plugin with afterModel and afterTool hooks", () => {
    const plugin = consoleLogger();

    expect(plugin.name).toBe("consoleLogger");
    expect(typeof plugin.hooks.afterModel).toBe("function");
    expect(typeof plugin.hooks.afterTool).toBe("function");
  });

  test("hooks do not throw with valid input", () => {
    const plugin = consoleLogger();
    const msgs = [{ role: "user" as const, content: "hi" }];

    // smoke test — hooks should not throw
    plugin.hooks.afterModel?.({ threadId: "t" }, msgs);
    plugin.hooks.afterTool?.(
      { threadId: "t" },
      { type: "tool_use", id: "t1", name: "read", input: {} },
      { type: "tool_result", tool_use_id: "t1", content: "ok" },
      msgs,
    );
  });
});
