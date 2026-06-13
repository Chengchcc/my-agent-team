import { afterAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteThreadProjectionReadAdapter } from "./adapter-sqlite.js";
import { createThreadProjectionService } from "./service.js";

const dbPath = `/tmp/test-thread-projection-svc-${Date.now()}.db`;
const db = openDb(dbPath);
const adapter = sqliteThreadProjectionReadAdapter(db);
const svc = createThreadProjectionService({ port: adapter });

afterAll(() => {
  db.close();
  try {
    unlinkSync(dbPath);
  } catch {
    /* best-effort cleanup */
  }
});

describe("ThreadProjectionService with SQLite", () => {
  test("getMessages returns persisted messages from real checkpointer", async () => {
    // Insert via raw SQL (simulating what harness checkpointer would do)
    const msgs = [{ role: "user" as const, content: "hello world" }];
    db.run("INSERT INTO checkpoint_messages (thread_id, messages, updated_at) VALUES (?, ?, ?)", [
      "th-1",
      JSON.stringify(msgs),
      Date.now(),
    ]);

    const result = await svc.getMessages("th-1");
    expect(result).toEqual(msgs);
  });

  test("getMessages returns empty array for unknown thread", async () => {
    const result = await svc.getMessages("nonexistent");
    expect(result).toEqual([]);
  });

  test("getMessages handles corrupted JSON gracefully", async () => {
    db.run(
      "INSERT OR REPLACE INTO checkpoint_messages (thread_id, messages, updated_at) VALUES (?, ?, ?)",
      ["th-corrupt", "{not valid json", Date.now()],
    );

    const result = await svc.getMessages("th-corrupt");
    expect(result).toEqual([]);
  });
});
