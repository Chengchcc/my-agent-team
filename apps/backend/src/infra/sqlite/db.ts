import { Database } from "bun:sqlite";
import { ALL_MIGRATIONS } from "./migrations.js";

export function openDb(path: string): Database {
  const db = new Database(path);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  db.exec("BEGIN");
  try {
    let currentVersion = (db.query("PRAGMA user_version").get() as { user_version: number })
      .user_version;

    for (const m of ALL_MIGRATIONS) {
      if (m.id > currentVersion) {
        db.exec(m.up);
        db.exec(`PRAGMA user_version = ${m.id}`);
        currentVersion = m.id;
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return db;
}
