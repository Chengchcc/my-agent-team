import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One task in the agent's list. */
export type TodoStatus = "pending" | "in_progress" | "done" | "cancelled";

export interface TodoItem {
  readonly id: string;
  readonly text: string;
  readonly status: TodoStatus;
}

/** The todo plugin's ONLY storage dependency: read the list, write a new one.
 *  Deliberately narrow — the plugin used to take a whole `SessionStore` (seven
 *  methods it never called) and every caller had to fabricate one, which is
 *  how a fake 7-method SessionStore ended up in production code. */
export interface TodoStore {
  read(): readonly TodoItem[];
  write(items: readonly TodoItem[]): void;
}

const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "done", "cancelled"];

function isStatus(value: unknown): value is TodoStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

/** Normalize untrusted items into the canonical shape: anything without a
 *  usable id/text is dropped, an unknown status degrades to "pending" (a
 *  hand-edited todo.json or a sloppy model must not inject a foreign status
 *  the renderer cannot label). Used for BOTH the model's tool input and the
 *  file contents — one validator, one behavior. */
export function normalizeTodoItems(values: readonly unknown[]): TodoItem[] {
  const out: TodoItem[] = [];
  for (const value of values) {
    if (typeof value !== "object" || value === null) continue;
    const item = value as { id?: unknown; text?: unknown; status?: unknown };
    if (typeof item.id !== "string" || typeof item.text !== "string") continue;
    out.push({
      id: item.id,
      text: item.text,
      status: isStatus(item.status) ? item.status : "pending",
    });
  }
  return out;
}

/** Standalone oma's local todo store: a single `.oma/todo.json` in the
 *  workspace, so todo_write persists across Runs and sessions (unlike the
 *  per-Run in-memory SessionStore). Backend-invoked RPC mode gets todo via the
 *  backend-injected MCP, never this file. */
const TODO_REL_PATH = ".oma/todo.json";

export function readTodoFile(workspaceRoot: string): readonly TodoItem[] {
  const path = join(workspaceRoot, TODO_REL_PATH);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return [];
    return normalizeTodoItems(parsed.items);
  } catch {
    return [];
  }
}

export function writeTodoFile(workspaceRoot: string, items: readonly TodoItem[]): void {
  const path = join(workspaceRoot, TODO_REL_PATH);
  mkdirSync(join(workspaceRoot, ".oma"), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ items }, null, 2)}\n`);
}

/** The workspace-file TodoStore: one `todo.json` per workspace. */
export function createFileTodoStore(workspaceRoot: string): TodoStore {
  return {
    read: () => readTodoFile(workspaceRoot),
    write: (items) => writeTodoFile(workspaceRoot, items),
  };
}
