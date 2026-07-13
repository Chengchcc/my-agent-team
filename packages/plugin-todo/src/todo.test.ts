import { describe, expect, it } from "bun:test";
import type { Message } from "@my-agent-team/message";
import { type Todo, todoPlugin } from "./todo.js";

/** Minimal fake HookContext for testing beforeModel. */
function fakeCtx(sessionId: string, emit?: (e: unknown) => void): never {
  return {
    sessionId,
    emit: emit as never,
  } as never;
}

describe("todoPlugin", () => {
  describe("plugin shape", () => {
    it("returns a plugin with name 'todo', beforeModel hook, and tools", () => {
      const plugin = todoPlugin();
      expect(plugin.name).toBe("todo");
      expect(plugin.hooks).toBeDefined();
      expect(typeof plugin.hooks!.beforeModel).toBe("function");
      expect(plugin.tools).toBeDefined();
      expect(plugin.tools!.map((t) => t.name)).toContain("todo_write");
    });
  });

  describe("todo_write tool - CRUD", () => {
    it("adds steps", async () => {
      const plugin = todoPlugin();
      const tool = plugin.tools!.find((t) => t.name === "todo_write")!;

      // beforeModel sets activeSessionId via ctx
      await plugin.hooks!.beforeModel!(fakeCtx("s1"), [{ role: "system", text: "sys" }]);

      const result = tool.execute({
        action: "add",
        steps: ["Read config", "Update port", "Restart service"],
      });
      expect(result.content).toContain("[ ] Read config");
      expect(result.content).toContain("[ ] Update port");
      expect(result.content).toContain("[ ] Restart service");
    });

    it("updates step status", async () => {
      const plugin = todoPlugin();
      const tool = plugin.tools!.find((t) => t.name === "todo_write")!;

      await plugin.hooks!.beforeModel!(fakeCtx("s1"), [{ role: "system", text: "sys" }]);
      tool.execute({ action: "add", steps: ["Step A", "Step B"] });

      const result = tool.execute({
        action: "update",
        updates: [{ step: "Step A", status: "in_progress" }],
      });
      expect(result.content).toContain("[>] Step A");
      expect(result.content).toContain("[ ] Step B");
    });

    it("moves steps up and down", async () => {
      const plugin = todoPlugin();
      const tool = plugin.tools!.find((t) => t.name === "todo_write")!;

      await plugin.hooks!.beforeModel!(fakeCtx("s1"), [{ role: "system", text: "sys" }]);
      tool.execute({ action: "add", steps: ["First", "Second", "Third"] });

      // Move "Second" up -> becomes first
      const up = tool.execute({ action: "move", step: "Second", direction: "up" });
      const lines = up.content.split("\n");
      expect(lines[0]).toContain("Second");

      // Move "Second" back down
      const down = tool.execute({ action: "move", step: "Second", direction: "down" });
      const lines2 = down.content.split("\n");
      expect(lines2[1]).toContain("Second");
    });

    it("deletes steps", async () => {
      const plugin = todoPlugin();
      const tool = plugin.tools!.find((t) => t.name === "todo_write")!;

      await plugin.hooks!.beforeModel!(fakeCtx("s1"), [{ role: "system", text: "sys" }]);
      tool.execute({ action: "add", steps: ["Keep", "Delete me"] });

      const result = tool.execute({ action: "delete", steps: ["Delete me"] });
      expect(result.content).toContain("Keep");
      expect(result.content).not.toContain("Delete me");
    });

    it("emits todo_update event on each operation", async () => {
      const plugin = todoPlugin();
      const tool = plugin.tools!.find((t) => t.name === "todo_write")!;
      const events: unknown[] = [];

      await plugin.hooks!.beforeModel!(
        fakeCtx("s1", (e: unknown) => events.push(e)),
        [{ role: "system", text: "sys" }],
      );

      tool.execute({ action: "add", steps: ["Step"] });
      expect(events).toHaveLength(1);
      const ev = events[0] as { type: string; payload: { todos: Todo[] } };
      expect(ev.type).toBe("todo_update");
      expect(ev.payload.todos).toHaveLength(1);
      expect(ev.payload.todos[0]!.step).toBe("Step");
    });
  });

  describe("beforeModel - progress injection", () => {
    it("does not inject when todos list is empty", async () => {
      const plugin = todoPlugin();
      const msgs: Message[] = [
        { role: "system", text: "sys" },
        { role: "user", text: "hi" },
      ];
      const result = await plugin.hooks!.beforeModel!(fakeCtx("s1"), msgs);
      expect(result).toHaveLength(2);
      expect(result[0]!.text).toBe("sys");
    });

    it("does not inject when showProgress is false", async () => {
      const plugin = todoPlugin({ showProgress: false });
      const tool = plugin.tools!.find((t) => t.name === "todo_write")!;

      // Seed todos
      await plugin.hooks!.beforeModel!(fakeCtx("s1"), [{ role: "system", text: "sys" }]);
      tool.execute({ action: "add", steps: ["Step A"] });

      // Even with todos, showProgress=false should not inject
      const msgs: Message[] = [
        { role: "system", text: "sys" },
        { role: "user", text: "hi" },
      ];
      const result = await plugin.hooks!.beforeModel!(fakeCtx("s1"), msgs);
      expect(result).toHaveLength(2);
      expect(result[0]!.text).toBe("sys");
    });

    it("injects <todo> block into system prompt when todos exist", async () => {
      const plugin = todoPlugin();
      const tool = plugin.tools!.find((t) => t.name === "todo_write")!;

      // Seed todos with mixed statuses
      await plugin.hooks!.beforeModel!(fakeCtx("s1"), [{ role: "system", text: "sys" }]);
      tool.execute({ action: "add", steps: ["Done step", "Active step", "Pending step"] });
      tool.execute({
        action: "update",
        updates: [
          { step: "Done step", status: "done" },
          { step: "Active step", status: "in_progress" },
        ],
      });

      // Now beforeModel should inject progress
      const msgs: Message[] = [
        { role: "system", text: "sys" },
        { role: "user", text: "hi" },
      ];
      const result = await plugin.hooks!.beforeModel!(fakeCtx("s1"), msgs);
      expect(result).toHaveLength(2);
      expect(result[0]!.text).toContain("<todo>");
      expect(result[0]!.text).toContain("[x] Done step");
      expect(result[0]!.text).toContain("[>] Active step");
      expect(result[0]!.text).toContain("[ ] Pending step");
      expect(result[0]!.text).toContain("</todo>");
    });
  });
});
