import { Database } from "bun:sqlite";
import { ALL_MIGRATIONS } from "./migrations.js";

export function openDb(path: string): Database {
  const db = new Database(path);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  // Create migration tracking table (idempotent)
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, id INTEGER NOT NULL, ran_at INTEGER NOT NULL)",
  );

  const ran = new Set(
    (db.query("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name),
  );

  for (const m of ALL_MIGRATIONS) {
    if (ran.has(m.name)) continue;
    db.exec(m.up);
    db.run("INSERT INTO _migrations (name, id, ran_at) VALUES (?, ?, ?)", [
      m.name,
      m.id,
      Date.now(),
    ]);
  }

  return db;
}
