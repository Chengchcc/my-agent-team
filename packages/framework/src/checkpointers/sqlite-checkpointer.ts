import { Database } from "bun:sqlite";
import path from "node:path";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { CheckpointEvent, Checkpointer, InterruptState } from "../checkpointer.js";
import * as schema from "./schema.js";

export interface SqliteCheckpointerOptions {
  db: Database | string;
}

/** Ensure the checkpointer tables exist. For standalone harness use.
 *  Uses drizzle-kit migrate() with ledger tracking. */
export function ensureCheckpointerSchema(db: Database): void {
  const d = drizzle(db, { schema, casing: "snake_case" });
  const migrationsFolder = path.resolve(import.meta.dirname, "../../drizzle");
  migrate(d, { migrationsFolder });
}

export function sqliteCheckpointer(opts: SqliteCheckpointerOptions): Checkpointer {
  const db: Database = typeof opts.db === "string" ? new Database(opts.db) : opts.db;

  // Run drizzle-kit migrations (replaces hand-rolled SQLITE_CHECKPOINTER_MIGRATIONS + _migrations ledger).
  ensureCheckpointerSchema(db);

  const d = drizzle(db, { schema, casing: "snake_case" });

  const cp: Checkpointer = {
    async save(threadId, messages) {
      const json = JSON.stringify(messages);
      const now = Date.now();
      d.insert(schema.checkpointMessages)
        .values({ threadId, messages: json, updatedAt: now })
        .onConflictDoUpdate({
          target: schema.checkpointMessages.threadId,
          set: { messages: json, updatedAt: now },
        })
        .run();
    },

    async load(threadId) {
      const row = d
        .select({ messages: schema.checkpointMessages.messages })
        .from(schema.checkpointMessages)
        .where(eq(schema.checkpointMessages.threadId, threadId))
        .get();
      if (!row) return null;
      try {
        return JSON.parse(row.messages);
      } catch {
        return null;
      }
    },

    async saveInterrupt(threadId: string, state: InterruptState): Promise<void> {
      const json = JSON.stringify(state);
      const now = Date.now();
      d.insert(schema.checkpointInterrupts)
        .values({ threadId, state: json, createdAt: now })
        .onConflictDoUpdate({
          target: schema.checkpointInterrupts.threadId,
          set: { state: json, createdAt: now },
        })
        .run();
    },

    async consumeInterrupt(threadId: string): Promise<InterruptState | null> {
      // M20: Atomize read-then-delete in a drizzle transaction.
      // The old code did SELECT → separate DELETE without a transaction,
      // which allowed concurrent calls to consume the same interrupt.
      const result = d.transaction((tx) => {
        const row = tx
          .select({ state: schema.checkpointInterrupts.state })
          .from(schema.checkpointInterrupts)
          .where(eq(schema.checkpointInterrupts.threadId, threadId))
          .get();
        if (!row) return null;
        tx.delete(schema.checkpointInterrupts)
          .where(eq(schema.checkpointInterrupts.threadId, threadId))
          .run();
        try {
          return JSON.parse(row.state) as InterruptState;
        } catch {
          return null;
        }
      });
      return result;
    },

    async appendEvent(threadId: string, event: CheckpointEvent): Promise<void> {
      const json = JSON.stringify(event);
      const ts = "ts" in event ? (event as { ts: number }).ts : Date.now();
      d.insert(schema.checkpointEvents).values({ threadId, event: json, ts }).run();
    },

    async *readEvents(threadId: string): AsyncIterable<CheckpointEvent> {
      const rows = d
        .select({ event: schema.checkpointEvents.event })
        .from(schema.checkpointEvents)
        .where(eq(schema.checkpointEvents.threadId, threadId))
        .orderBy(schema.checkpointEvents.id)
        .all();
      for (const row of rows) {
        try {
          yield JSON.parse(row.event) as CheckpointEvent;
        } catch {
          /* skip corrupted rows */
        }
      }
    },

    async deleteThread(threadId: string): Promise<void> {
      d.delete(schema.checkpointMessages)
        .where(eq(schema.checkpointMessages.threadId, threadId))
        .run();
      d.delete(schema.checkpointInterrupts)
        .where(eq(schema.checkpointInterrupts.threadId, threadId))
        .run();
      d.delete(schema.checkpointEvents)
        .where(eq(schema.checkpointEvents.threadId, threadId))
        .run();
    },
  };

  return cp;
}
