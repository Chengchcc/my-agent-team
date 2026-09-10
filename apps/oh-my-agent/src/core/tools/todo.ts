import type { Plugin, PluginTool } from "../index.js";
import { normalizeTodoItems, type TodoStore } from "./todo-store.js";

export interface TodoPluginOptions {
  readonly store: TodoStore;
}

function createTodoWriteTool(opts: TodoPluginOptions): PluginTool {
  return {
    name: "todo_write",
    description: "Update the task list. Provide the full desired state.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "done", "cancelled"] },
            },
            required: ["id", "text", "status"],
          },
        },
      },
      required: ["items"],
    },
    async execute(
      args: Readonly<Record<string, unknown>>,
    ): Promise<Readonly<Record<string, unknown>>> {
      const rawItems = args.items;
      if (!Array.isArray(rawItems)) return { error: "items must be an array" };
      const items = normalizeTodoItems(rawItems);
      opts.store.write(items);
      return { items };
    },
  };
}

export function createTodo(opts: TodoPluginOptions): Plugin {
  return {
    name: "todo",
    tools: [createTodoWriteTool(opts)],
    hooks: {
      afterTool(toolName: string, result: unknown) {
        if (toolName !== "todo_write") return undefined;
        if (typeof result !== "object" || result === null) return undefined;
        if (!("items" in result) || !Array.isArray(result.items)) return undefined;
        return { type: "todo_update", items: normalizeTodoItems(result.items) };
      },
    },
    meta: [
      {
        name: "Todo",
        render(): string {
          return "Use todo_write to track tasks. State persists across sessions.";
        },
      },
    ],
  };
}

export function createTodoReadTool(opts: TodoPluginOptions): PluginTool {
  return {
    name: "todo_read",
    description: "Read the current task list.",
    inputSchema: { type: "object", properties: {} },
    async execute(): Promise<Readonly<Record<string, unknown>>> {
      return { items: opts.store.read() };
    },
  };
}
