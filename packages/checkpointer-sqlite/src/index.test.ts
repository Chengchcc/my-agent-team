import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { sqliteCheckpointer } from "./index.js";

let db: Database;
let nextId = 0;

function freshDb(): Database {
  return new Database(":memory:");
}

// ─── Save / Load (Tier 1) ─────────────────────────────────────

test("save and load roundtrip", async () => {
  const db = freshDb();
  const cp = sqliteCheckpointer({ db });
  const msgs = [{ role: "user" as const, content: "hello" }];

  await cp.save("t1", msgs);
  const loaded = await cp.load("t1");

  expect(loaded).toEqual(msgs);
});

test("load returns null for unknown threadId", async () => {
  const db = freshDb();
  const cp = sqliteCheckpointer({ db });

  const loaded = await cp.load("nonexistent");
  expect(loaded).toBeNull();
});

test("save overwrites previous state for same threadId", async () => {
  const db = freshDb();
  const cp = sqliteCheckpointer({ db });

  await cp.save("t1", [{ role: "user" as const, content: "first" }]);
  await cp.save("t1", [{ role: "user" as const, content: "second" }]);

  const loaded = await cp.load("t1");
  expect(loaded).toEqual([{ role: "user", content: "second" }]);
});

// ─── Interrupt (Tier 2) ───────────────────────────────────────

test("saveInterrupt and consumeInterrupt roundtrip", async () => {
  const db = freshDb();
  const cp = sqliteCheckpointer({ db });

  await cp.saveInterrupt!("t1", {
    pendingTool: { call: { type: "tool_use" as const, id: "c1", name: "bash", input: {} }, reason: "permission" },
    ts: 1000,
  });

  const state = await cp.consumeInterrupt!("t1");
  expect(state).not.toBeNull();
  expect(state!.pendingTool.reason).toBe("permission");
});

test("consumeInterrupt is one-shot (consumed after read)", async () => {
  const db = freshDb();
  const cp = sqliteCheckpointer({ db });

  await cp.saveInterrupt!("t1", {
    pendingTool: { call: { type: "tool_use" as const, id: "c1", name: "bash", input: {} }, reason: "permission" },
    ts: 1000,
  });

  await cp.consumeInterrupt!("t1");
  const second = await cp.consumeInterrupt!("t1");
  expect(second).toBeNull();
});

test("consumeInterrupt returns null when no interrupt saved", async () => {
  const db = freshDb();
  const cp = sqliteCheckpointer({ db });

  const state = await cp.consumeInterrupt!("t1");
  expect(state).toBeNull();
});

// ─── Events (Tier 3) ──────────────────────────────────────────

test("appendEvent and readEvents roundtrip", async () => {
  const db = freshDb();
  const cp = sqliteCheckpointer({ db });

  await cp.appendEvent!("t1", { type: "user_input", content: "hi", ts: 1 });
  await cp.appendEvent!("t1", { type: "run_end", reason: "complete", ts: 2 });

  const events: unknown[] = [];
  for await (const ev of cp.readEvents!("t1")) {
    events.push(ev);
  }

  expect(events.length).toBe(2);
  expect(events[0]).toHaveProperty("type", "user_input");
  expect(events[1]).toHaveProperty("type", "run_end");
});

test("readEvents yields empty for unknown threadId", async () => {
  const db = freshDb();
  const cp = sqliteCheckpointer({ db });

  const events: unknown[] = [];
  for await (const ev of cp.readEvents!("nonexistent")) {
    events.push(ev);
  }

  expect(events.length).toBe(0);
});

test("events are returned in insertion order", async () => {
  const db = freshDb();
  const cp = sqliteCheckpointer({ db });

  for (let i = 0; i < 5; i++) {
    await cp.appendEvent!("t1", { type: "user_input", content: `msg${i}`, ts: i });
  }

  const events: unknown[] = [];
  for await (const ev of cp.readEvents!("t1")) {
    events.push(ev);
  }

  expect(events.length).toBe(5);
  // @ts-expect-error content is on the event payload
  expect(events[0]?.content).toBe("msg0");
  // @ts-expect-error
  expect(events[4]?.content).toBe("msg4");
});

// ─── db: string mode ──────────────────────────────────────────

test("db: string mode creates file and works", async () => {
  const tmpPath = `/tmp/test-sqlite-cp-${Date.now()}.db`;
  const cp = sqliteCheckpointer({ db: tmpPath });

  await cp.save("t1", [{ role: "user" as const, content: "persisted" }]);

  // Re-open with a new checkpointer instance to verify persistence
  const cp2 = sqliteCheckpointer({ db: tmpPath });
  const loaded = await cp2.load("t1");
  expect(loaded).toEqual([{ role: "user", content: "persisted" }]);

  // Cleanup
  try { require("node:fs").unlinkSync(tmpPath); } catch {}
});

// ─── Capability detection ─────────────────────────────────────

test("all capability methods are present (full Checkpointer)", () => {
  const db = freshDb();
  const cp = sqliteCheckpointer({ db });

  expect(typeof cp.save).toBe("function");
  expect(typeof cp.load).toBe("function");
  expect(typeof cp.saveInterrupt).toBe("function");
  expect(typeof cp.consumeInterrupt).toBe("function");
  expect(typeof cp.appendEvent).toBe("function");
  expect(typeof cp.readEvents).toBe("function");
});

// ─── WAL mode ─────────────────────────────────────────────────

test("WAL journal mode is enabled for file-based databases", () => {
  const tmpPath = `/tmp/test-sqlite-cp-wal-${Date.now()}.db`;
  const db = new Database(tmpPath);
  sqliteCheckpointer({ db });

  const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
  expect(row.journal_mode).toBe("wal");

  db.close();
  try { require("node:fs").unlinkSync(tmpPath); } catch {}
});

// ─── SQLITE_CHECKPOINTER_MIGRATIONS ────────────────────────────

test("migrations array is re-exported with id and up fields", async () => {
  const { SQLITE_CHECKPOINTER_MIGRATIONS } = await import("./index.js");
  expect(Array.isArray(SQLITE_CHECKPOINTER_MIGRATIONS)).toBe(true);
  expect(SQLITE_CHECKPOINTER_MIGRATIONS.length).toBeGreaterThan(0);

  for (const m of SQLITE_CHECKPOINTER_MIGRATIONS) {
    expect(typeof m.id).toBe("number");
    expect(typeof m.up).toBe("string");
    expect(m.up.length).toBeGreaterThan(0);
  }
});
