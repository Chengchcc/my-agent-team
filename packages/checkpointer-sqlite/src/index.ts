import type { Checkpointer, CheckpointEvent, InterruptState } from "@my-agent-team/framework";
import { Database } from "bun:sqlite";

export interface SqliteCheckpointerOptions {
  db: Database | string;
  tablePrefix?: string;
}

export const SQLITE_CHECKPOINTER_MIGRATIONS: readonly { id: number; up: string }[] = [
  {
    id: 1,
    up: `CREATE TABLE IF NOT EXISTS checkpoint_messages (
  thread_id  TEXT PRIMARY KEY,
  messages   TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  },
  {
    id: 2,
    up: `CREATE TABLE IF NOT EXISTS checkpoint_interrupts (
  thread_id  TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`,
  },
  {
    id: 3,
    up: `CREATE TABLE IF NOT EXISTS checkpoint_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL,
  event      TEXT NOT NULL,
  ts         INTEGER NOT NULL
)`,
  },
  {
    id: 4,
    up: `CREATE INDEX IF NOT EXISTS idx_checkpoint_events_thread ON checkpoint_events(thread_id, id)`,
  },
];

function runMigrations(db: Database, prefix: string): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  for (const m of SQLITE_CHECKPOINTER_MIGRATIONS) {
    db.exec(m.up);
  }
}

function table(prefix: string, name: string): string {
  return prefix ? `${prefix}${name}` : name;
}

export function sqliteCheckpointer(opts: SqliteCheckpointerOptions): Checkpointer {
  const db: Database = typeof opts.db === "string" ? new Database(opts.db) : opts.db;
  const prefix = opts.tablePrefix ?? "";

  runMigrations(db, prefix);

  const msgTable = table(prefix, "checkpoint_messages");
  const intTable = table(prefix, "checkpoint_interrupts");
  const evTable = table(prefix, "checkpoint_events");

  const cp: Checkpointer = {
    async save(threadId, messages) {
      const json = JSON.stringify(messages);
      db.run(
        `INSERT INTO ${msgTable} (thread_id, messages, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at`,
        [threadId, json, Date.now()],
      );
    },

    async load(threadId) {
      const row = db
        .query(`SELECT messages FROM ${msgTable} WHERE thread_id = ?`)
        .get(threadId) as { messages: string } | undefined;
      if (!row) return null;
      return JSON.parse(row.messages);
    },

    async saveInterrupt(threadId: string, state: InterruptState): Promise<void> {
      const json = JSON.stringify(state);
      db.run(
        `INSERT INTO ${intTable} (thread_id, state, created_at) VALUES (?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET state = excluded.state, created_at = excluded.created_at`,
        [threadId, json, Date.now()],
      );
    },

    async consumeInterrupt(threadId: string): Promise<InterruptState | null> {
      const row = db
        .query(`SELECT state FROM ${intTable} WHERE thread_id = ?`)
        .get(threadId) as { state: string } | undefined;
      if (!row) return null;
      db.run(`DELETE FROM ${intTable} WHERE thread_id = ?`, [threadId]);
      return JSON.parse(row.state) as InterruptState;
    },

    async appendEvent(threadId: string, event: CheckpointEvent): Promise<void> {
      const json = JSON.stringify(event);
      const ts = "ts" in event ? (event as { ts: number }).ts : Date.now();
      db.run(`INSERT INTO ${evTable} (thread_id, event, ts) VALUES (?, ?, ?)`, [threadId, json, ts]);
    },

    async *readEvents(threadId: string): AsyncIterable<CheckpointEvent> {
      const rows = db
        .query(`SELECT event FROM ${evTable} WHERE thread_id = ? ORDER BY id ASC`)
        .all(threadId) as { event: string }[];
      for (const row of rows) {
        yield JSON.parse(row.event) as CheckpointEvent;
      }
    },
  };

  return cp;
}
