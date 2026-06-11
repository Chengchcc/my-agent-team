import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

function setupEventsDb() {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE run (
    run_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  )`);
  db.run(`CREATE TABLE attempt (
    attempt_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    pid INTEGER,
    heartbeat_at INTEGER,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  )`);
  return db;
}

// Test the SQL query logic directly (getCurrentRun relies on supervisor.getDb())
describe("getCurrentRun query", () => {
  test("returns active run for thread (ended_at IS NULL)", () => {
    const db = setupEventsDb();
    const now = Date.now();

    // Insert a running run
    db.run("INSERT INTO run (run_id, thread_id, status, started_at) VALUES (?, ?, ?, ?)", [
      "run-1",
      "thread-1",
      "running",
      now,
    ]);

    const row = db
      .query(
        "SELECT run_id, status FROM run WHERE thread_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
      )
      .get("thread-1") as { run_id: string; status: string } | undefined;

    expect(row).not.toBeNull();
    expect(row?.run_id).toBe("run-1");
    expect(row?.status).toBe("running");
  });

  test("returns null when no active run exists", () => {
    const db = setupEventsDb();
    const now = Date.now();

    // Insert a completed run
    db.run(
      "INSERT INTO run (run_id, thread_id, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?)",
      ["run-done", "thread-2", "succeeded", now - 10000, now],
    );

    const row = db
      .query(
        "SELECT run_id, status FROM run WHERE thread_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
      )
      .get("thread-2") as { run_id: string; status: string } | undefined;

    expect(row).toBeNull();
  });

  test("returns null for thread with no runs", () => {
    const db = setupEventsDb();
    const row = db
      .query(
        "SELECT run_id, status FROM run WHERE thread_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
      )
      .get("nonexistent") as { run_id: string; status: string } | undefined;

    expect(row).toBeNull();
  });

  test("returns most recent active run when multiple exist", () => {
    const db = setupEventsDb();
    const now = Date.now();

    db.run(
      "INSERT INTO run (run_id, thread_id, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?)",
      ["run-old", "thread-3", "succeeded", now - 20000, now - 10000],
    );
    db.run("INSERT INTO run (run_id, thread_id, status, started_at) VALUES (?, ?, ?, ?)", [
      "run-active",
      "thread-3",
      "interrupted",
      now - 5000,
    ]);

    const row = db
      .query(
        "SELECT run_id, status FROM run WHERE thread_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
      )
      .get("thread-3") as { run_id: string; status: string } | undefined;

    expect(row).not.toBeNull();
    expect(row?.run_id).toBe("run-active");
  });
});
