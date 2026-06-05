import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { openDb } from "./db.js";

// ─── Test 1: openDb creates file and runs migrations ────────────

test("openDb creates database file and runs migrations", () => {
  const tmpPath = `/tmp/test-backend-db-${Date.now()}.db`;
  const db = openDb(tmpPath);

  // Verify tables exist (backend own + checkpointer)
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];

  const names = tables.map((t) => t.name);
  expect(names).toContain("agents");
  expect(names).toContain("threads");
  expect(names).toContain("runs");
  expect(names).toContain("checkpoint_messages");
  expect(names).toContain("checkpoint_interrupts");
  expect(names).toContain("checkpoint_events");

  db.close();
  try { require("node:fs").unlinkSync(tmpPath); } catch {}
});

// ─── Test 2: migrations are idempotent ──────────────────────────

test("migrations are idempotent (calling openDb twice is safe)", () => {
  const tmpPath = `/tmp/test-backend-db-idem-${Date.now()}.db`;

  const db1 = openDb(tmpPath);
  const tables1 = (db1.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  db1.close();

  // Second open should not error
  const db2 = openDb(tmpPath);
  const tables2 = (db2.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  db2.close();

  expect(tables2).toEqual(tables1);

  try { require("node:fs").unlinkSync(tmpPath); } catch {}
});

// ─── Test 3: user_version tracks migration progress ─────────────

test("user_version tracks migration count", () => {
  const tmpPath = `/tmp/test-backend-db-ver-${Date.now()}.db`;
  const db = openDb(tmpPath);

  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  expect(row.user_version).toBeGreaterThan(0);

  db.close();
  try { require("node:fs").unlinkSync(tmpPath); } catch {}
});

// ─── Test 4: WAL mode is enabled ────────────────────────────────

test("WAL journal mode is enabled", () => {
  const tmpPath = `/tmp/test-backend-db-wal-${Date.now()}.db`;
  const db = openDb(tmpPath);

  const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
  expect(row.journal_mode).toBe("wal");

  db.close();
  try { require("node:fs").unlinkSync(tmpPath); } catch {}
});
