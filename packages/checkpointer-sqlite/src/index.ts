import { Database } from "bun:sqlite";
import type { CheckpointEvent, Checkpointer, InterruptState } from "@my-agent-team/framework";

export interface SqliteCheckpointerOptions {
  db: Database | string;
  tablePrefix?: string;
}

export const SQLITE_CHECKPOINTER_MIGRATIONS: readonly { name: string; id: number; up: string }[] = [
  {
    name: "checkpointer_v1_messages",
    id: 1000,
    up: `CREATE TABLE IF NOT EXISTS checkpoint_messages (
  thread_id  TEXT PRIMARY KEY,
  messages   TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`,
  },
  {
    name: "checkpointer_v2_interrupts",
    id: 1001,
    up: `CREATE TABLE IF NOT EXISTS checkpoint_interrupts (
  thread_id  TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`,
  },
  {
    name: "checkpointer_v3_events",
    id: 1002,
    up: `CREATE TABLE IF NOT EXISTS checkpoint_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id  TEXT NOT NULL,
  event      TEXT NOT NULL,
  ts         INTEGER NOT NULL
)`,
  },
  {
    name: "checkpointer_v4_events_idx",
    id: 1003,
    up: `CREATE INDEX IF NOT EXISTS idx_checkpoint_events_thread ON checkpoint_events(thread_id, id)`,
  },
];

/** Ensure the checkpointer tables exist. For standalone harness use. Uses a ledger to avoid re-running. */
export function ensureCheckpointerSchema(db: Database): void {
  runMigrations(db, SQLITE_CHECKPOINTER_MIGRATIONS);
}

function runMigrations(
  db: Database,
  migrations: readonly { name: string; id: number; up: string }[],
): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  // Create migration tracking table (idempotent)
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, id INTEGER NOT NULL, ran_at INTEGER NOT NULL)",
  );

  const ran = new Set(
    (db.query("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name),
  );

  // Backfill: if _migrations is empty, register all migrations as applied.
  // Tables created by prior runs via IF NOT EXISTS are already present.
  for (const m of migrations) {
    if (ran.has(m.name)) continue;
    db.exec(m.up);
    db.run("INSERT INTO _migrations (name, id, ran_at) VALUES (?, ?, ?)", [
      m.name,
      m.id,
      Date.now(),
    ]);
  }
}

function table(prefix: string, name: string): string {
  return prefix ? `${prefix}${name}` : name;
}

export function sqliteCheckpointer(opts: SqliteCheckpointerOptions): Checkpointer {
  const db: Database = typeof opts.db === "string" ? new Database(opts.db) : opts.db;
  const prefix = opts.tablePrefix ?? "";

  if (prefix) throw new Error("tablePrefix is not yet supported");

  // Run migrations with ledger tracking (idempotent)
  runMigrations(db, SQLITE_CHECKPOINTER_MIGRATIONS);

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
      const row = db.query(`SELECT messages FROM ${msgTable} WHERE thread_id = ?`).get(threadId) as
        | { messages: string }
        | undefined;
      if (!row) return null;
      try {
        return JSON.parse(row.messages);
      } catch {
        return null;
      }
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
      const row = db.query(`SELECT state FROM ${intTable} WHERE thread_id = ?`).get(threadId) as
        | { state: string }
        | undefined;
      if (!row) return null;
      db.run(`DELETE FROM ${intTable} WHERE thread_id = ?`, [threadId]);
      try {
        return JSON.parse(row.state) as InterruptState;
      } catch {
        return null;
      }
    },

    async appendEvent(threadId: string, event: CheckpointEvent): Promise<void> {
      const json = JSON.stringify(event);
      const ts = "ts" in event ? (event as { ts: number }).ts : Date.now();
      db.run(`INSERT INTO ${evTable} (thread_id, event, ts) VALUES (?, ?, ?)`, [
        threadId,
        json,
        ts,
      ]);
    },

    async *readEvents(threadId: string): AsyncIterable<CheckpointEvent> {
      const rows = db
        .query(`SELECT event FROM ${evTable} WHERE thread_id = ? ORDER BY id ASC`)
        .all(threadId) as { event: string }[];
      for (const row of rows) {
        try {
          yield JSON.parse(row.event) as CheckpointEvent;
        } catch {
          /* skip corrupted rows */
        }
      }
    },
  };

  return cp;
}
