import { expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { openDb } from "./db.js";

// ─── Test 1: openDb creates file and runs drizzle-kit migrations ───

test("openDb creates database file and runs drizzle-kit migrations", () => {
  const tmpPath = `/tmp/test-backend-db-${Date.now()}.db`;
  const db = openDb(tmpPath);

  // Verify tables exist (backend own, 9 domain tables)
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];

  const names = tables.map((t) => t.name);
  expect(names).toContain("agents");
  expect(names).not.toContain("threads");
  // S1: events.db merged — run/attempt are now in backend.db
  expect(names).toContain("run");
  expect(names).toContain("attempt");
  // S2: projection_messages deleted (redundant third copy of messages)
  expect(names).not.toContain("projection_messages");
  // M20: checkpoint_* tables are in checkpointer.sqlite, NOT backend.db
  expect(names).not.toContain("checkpoint_messages");
  expect(names).not.toContain("checkpoint_interrupts");
  expect(names).not.toContain("checkpoint_events");
  // drizzle-kit migration ledger (replaces old _migrations)
  expect(names).toContain("__drizzle_migrations");

  db.close();
  try {
    unlinkSync(tmpPath);
  } catch {
    /* best-effort cleanup */
  }
});

// ─── Test 2: migrations are idempotent ──────────────────────────

test("migrations are idempotent (calling openDb twice is safe)", () => {
  const tmpPath = `/tmp/test-backend-db-idem-${Date.now()}.db`;

  const db1 = openDb(tmpPath);
  const tables1 = (
    db1.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((t) => t.name);
  db1.close();

  // Second open should not error
  const db2 = openDb(tmpPath);
  const tables2 = (
    db2.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((t) => t.name);
  db2.close();

  expect(tables2).toEqual(tables1);

  try {
    unlinkSync(tmpPath);
  } catch {
    /* best-effort cleanup */
  }
});

// ─── Test 3: drizzle migration ledger is populated ──────────────

test("__drizzle_migrations table tracks applied migrations", () => {
  const tmpPath = `/tmp/test-backend-db-ver-${Date.now()}.db`;
  const db = openDb(tmpPath);

  const rows = db.query("SELECT hash FROM __drizzle_migrations").all() as {
    hash: string;
  }[];
  expect(rows.length).toBeGreaterThan(0);

  db.close();
  try {
    unlinkSync(tmpPath);
  } catch {
    /* best-effort cleanup */
  }
});

// ─── Test 4: WAL mode is enabled ────────────────────────────────

test("WAL journal mode is enabled", () => {
  const tmpPath = `/tmp/test-backend-db-wal-${Date.now()}.db`;
  const db = openDb(tmpPath);

  const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
  expect(row.journal_mode).toBe("wal");

  db.close();
  try {
    unlinkSync(tmpPath);
  } catch {
    /* best-effort cleanup */
  }
});

// ─── Test 5: M10 conversation tables exist ─────────────────────

test("M10 conversation/member/conversation_ledger tables exist after migration", () => {
  const tmpPath = `/tmp/test-backend-db-m10-${Date.now()}.db`;
  const db = openDb(tmpPath);

  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as { name: string }[];

  const names = tables.map((t) => t.name);
  expect(names).toContain("conversation");
  expect(names).toContain("member");
  expect(names).toContain("conversation_ledger");

  // Verify conversation table shape
  const convCols = db.query("PRAGMA table_info('conversation')").all() as { name: string }[];
  expect(convCols.map((c) => c.name)).toContain("trigger_mode");
  expect(convCols.map((c) => c.name)).toContain("hop_count");

  // Verify member table shape
  const memCols = db.query("PRAGMA table_info('member')").all() as { name: string }[];
  expect(memCols.map((c) => c.name)).toContain("conversation_id");
  expect(memCols.map((c) => c.name)).toContain("kind");

  // Verify conversation_ledger shape
  const ledgerCols = db.query("PRAGMA table_info('conversation_ledger')").all() as {
    name: string;
  }[];
  expect(ledgerCols.map((c) => c.name)).toContain("seq");
  expect(ledgerCols.map((c) => c.name)).toContain("sender_member_id");
  expect(ledgerCols.map((c) => c.name)).toContain("kind");

  db.close();
  try {
    unlinkSync(tmpPath);
  } catch {
    /* best-effort cleanup */
  }
});
