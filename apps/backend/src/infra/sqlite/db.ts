import { Database } from "bun:sqlite";
import { ALL_MIGRATIONS } from "./migrations.js";

export function openDb(path: string): Database {
  const db = new Database(path);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  const currentVersion = (
    db.query("PRAGMA user_version").get() as { user_version: number }
  ).user_version;

  for (const m of ALL_MIGRATIONS) {
    if (m.id > currentVersion) {
      db.exec(m.up);
    }
  }

  const maxId = ALL_MIGRATIONS.length > 0 ? ALL_MIGRATIONS[ALL_MIGRATIONS.length - 1]!.id : 0;
  db.exec(`PRAGMA user_version = ${maxId}`);

  return db;
}
