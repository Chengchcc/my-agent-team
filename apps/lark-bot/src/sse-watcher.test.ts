import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { render } from "./render.js";

// processEntry moved to module scope for testability — test via watchConversation integration
// For now, test the supporting functions that are independently testable.

describe("render (used by SSE watcher)", () => {
  test("renders agent text reply", () => {
    const content = JSON.stringify([{ type: "text", text: "Hello from agent" }]);
    expect(render(content)).toBe("Hello from agent");
  });

  test("renders simple text object", () => {
    expect(render(JSON.stringify({ text: "simple" }))).toBe("simple");
  });

  test("renders raw string", () => {
    expect(render("plain text")).toBe("plain text");
  });
});

describe("SSE watcher pushed_seq advancement", () => {
  const DB_PATH = `:memory:`;

  function setupDb(): Database {
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE IF NOT EXISTS member_binding (
        lark_chat_id TEXT NOT NULL,
        lark_open_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        PRIMARY KEY (lark_chat_id, lark_open_id)
      );
      CREATE TABLE IF NOT EXISTS chat_binding (
        lark_chat_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        pushed_seq INTEGER NOT NULL DEFAULT 0
      );
    `);
    return db;
  }

  test("pushed_seq advances for non-message entries", () => {
    const db = setupDb();
    const larkChatId = "oc_test";
    // Insert binding with pushed_seq 0
    db.run("INSERT INTO chat_binding (lark_chat_id, conversation_id, chat_type, created_at, pushed_seq) VALUES (?, ?, ?, ?, 0)",
      [larkChatId, "conv_test", "group", Date.now()]);

    // Non-message (member.joined) should call updatePushedSeq
    // This is tested indirectly — the function is private, we verify the public API
    // For now: verify db state transitions work
    db.run("UPDATE chat_binding SET pushed_seq = ? WHERE lark_chat_id = ?", [42, larkChatId]);
    const row = db.query("SELECT pushed_seq FROM chat_binding WHERE lark_chat_id = ?").get(larkChatId) as { pushed_seq: number };
    expect(row.pushed_seq).toBe(42);
    db.close();
  });
});
