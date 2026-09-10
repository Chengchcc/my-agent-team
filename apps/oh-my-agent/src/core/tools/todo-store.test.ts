import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileTodoStore, readTodoFile, writeTodoFile } from "./todo-store.js";

describe("todo store", () => {
  test("write/read file round trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-todo-"));
    try {
      const items = [{ id: "t1", text: "plan", status: "pending" }] as const;
      writeTodoFile(dir, items);
      expect(readTodoFile(dir)).toEqual(items);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("junk entries are dropped and an unknown status degrades to pending", () => {
    // The file is agent-writable and hand-editable: a foreign status must not
    // reach the renderer, and a malformed row must not break the whole list.
    const dir = mkdtempSync(join(tmpdir(), "oma-todo-junk-"));
    try {
      writeTodoFile(dir, []);
      const path = join(dir, ".oma", "todo.json");
      Bun.write(
        path,
        JSON.stringify({
          items: [
            { id: "ok", text: "keep", status: "done" },
            { id: "weird", text: "unknown status", status: "URGENT" },
            { id: "no-text", status: "pending" },
            "not-an-object",
            null,
          ],
        }),
      );
      expect(readTodoFile(dir)).toEqual([
        { id: "ok", text: "keep", status: "done" },
        { id: "weird", text: "unknown status", status: "pending" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing or corrupt file reads as an empty list, never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-todo-bad-"));
    try {
      expect(readTodoFile(dir)).toEqual([]);
      writeTodoFile(dir, []);
      Bun.write(join(dir, ".oma", "todo.json"), "{not json");
      expect(readTodoFile(dir)).toEqual([]);
      Bun.write(join(dir, ".oma", "todo.json"), JSON.stringify({ items: "nope" }));
      expect(readTodoFile(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("state survives a restart: a FRESH store instance reads the same list", () => {
    // The production claim (todo persists across Runs and sessions for
    // standalone oma): the store is stateless, so a new process must observe
    // what the previous one wrote.
    const dir = mkdtempSync(join(tmpdir(), "oma-todo-restart-"));
    try {
      createFileTodoStore(dir).write([{ id: "t1", text: "task", status: "in_progress" }]);
      const reopened = createFileTodoStore(dir);
      expect(reopened.read()).toEqual([{ id: "t1", text: "task", status: "in_progress" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
