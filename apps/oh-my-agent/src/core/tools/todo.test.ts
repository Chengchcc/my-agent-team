import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTodo, createTodoReadTool } from "./todo.js";
import { createFileTodoStore, type TodoItem, type TodoStore } from "./todo-store.js";

/** In-memory double for the plugin's storage seam: two methods, no preamble. */
function memoryStore(initial: readonly TodoItem[] = []): TodoStore & { written: TodoItem[][] } {
  let items: readonly TodoItem[] = initial;
  const written: TodoItem[][] = [];
  return {
    written,
    read: () => items,
    write(next) {
      items = next;
      written.push([...next]);
    },
  };
}

describe("todo plugin", () => {
  test("todo_write persists through the store and normalizes model input", async () => {
    const store = memoryStore();
    const plugin = createTodo({ store });
    expect(plugin.name).toBe("todo");
    expect(plugin.tools?.map((t) => t.name)).toEqual(["todo_write"]);

    const tool = plugin.tools![0]!;
    const result = (await tool.execute({
      items: [
        { id: "t1", text: "task 1", status: "pending" },
        { id: "t2", text: "task 2", status: "NOT-A-STATUS" },
        { text: "missing id", status: "pending" },
      ],
    })) as { items: TodoItem[] };

    // Bad status degrades to pending; a row without an id is dropped.
    expect(result.items).toEqual([
      { id: "t1", text: "task 1", status: "pending" },
      { id: "t2", text: "task 2", status: "pending" },
    ]);
    expect(store.read()).toEqual(result.items);
    expect(store.written).toHaveLength(1);
  });

  test("a non-array items argument is refused and writes nothing", async () => {
    const store = memoryStore();
    const tool = createTodo({ store }).tools![0]!;
    expect(await tool.execute({ items: "nope" })).toEqual({ error: "items must be an array" });
    expect(store.written).toEqual([]);
  });

  test("todo_read returns the current list", async () => {
    const store = memoryStore([{ id: "a", text: "step", status: "done" }]);
    const tool = createTodoReadTool({ store });
    expect(tool.name).toBe("todo_read");
    expect(await tool.execute()).toEqual({ items: [{ id: "a", text: "step", status: "done" }] });
  });

  test("afterTool emits todo_update only for todo_write", () => {
    const plugin = createTodo({ store: memoryStore() });
    const hook = plugin.hooks?.afterTool;
    expect(hook).toBeDefined();

    expect(
      hook!(
        "todo_write",
        {
          items: [
            { id: "a", text: "step 1", status: "done" },
            { id: "b", text: "step 2", status: "pending" },
          ],
        },
        undefined as never,
      ),
    ).toEqual({
      type: "todo_update",
      items: [
        { id: "a", text: "step 1", status: "done" },
        { id: "b", text: "step 2", status: "pending" },
      ],
    });

    expect(hook!("ls", {}, undefined as never)).toBeUndefined();
    // A result without an items array (or a non-object) emits nothing.
    expect(hook!("todo_write", null, undefined as never)).toBeUndefined();
    expect(hook!("todo_write", { items: "nope" }, undefined as never)).toBeUndefined();
  });

  test("round trip through the workspace file store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-todo-plugin-"));
    try {
      const store = createFileTodoStore(dir);
      await createTodo({ store }).tools![0]!.execute({
        items: [{ id: "t1", text: "persisted", status: "in_progress" }],
      });
      // A separate read tool over a fresh store sees the written state.
      const read = createTodoReadTool({ store: createFileTodoStore(dir) });
      expect(await read.execute()).toEqual({
        items: [{ id: "t1", text: "persisted", status: "in_progress" }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
