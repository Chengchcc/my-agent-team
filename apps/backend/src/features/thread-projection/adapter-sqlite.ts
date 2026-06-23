import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import type { ThreadProjectionReadPort, ThreadProjectionWritePort } from "./ports.js";

export function sqliteThreadProjectionReadAdapter(db: Database): ThreadProjectionReadPort {
  const d = drizzle(db, { schema, casing: "snake_case" });

  return {
    async getMessages(threadId: string): Promise<unknown[] | null> {
      const row = d
        .select({ messages: schema.projectionMessages.messages })
        .from(schema.projectionMessages)
        .where(eq(schema.projectionMessages.threadId, threadId))
        .get();
      if (!row) return null;
      try {
        return JSON.parse(row.messages);
      } catch {
        return null;
      }
    },
  };
}

/** Write adapter for broadcast projection — load→merge→save.
 *  M17.4: Uses projection_messages table (no longer borrows checkpointer's table name).
 *
 *  M20: BEGIN IMMEDIATE write-lock transaction retained.
 *  drizzle's default transaction is DEFERRED, which would risk lost updates under
 *  concurrent load-merge-save. The raw IMMEDIATE lock is the correct semantic. */
export function sqliteThreadProjectionWriteAdapter(db: Database): ThreadProjectionWritePort {
  const d = drizzle(db, { schema, casing: "snake_case" });

  return {
    async appendMessages(threadId: string, msgs: unknown[]): Promise<void> {
      // BEGIN IMMEDIATE retained: must use write-lock, not DEFERRED.
      // drizzle transaction() does not support IMMEDIATE — keep raw lock boundary.
      db.run("BEGIN IMMEDIATE");
      try {
        const row = d
          .select({ messages: schema.projectionMessages.messages })
          .from(schema.projectionMessages)
          .where(eq(schema.projectionMessages.threadId, threadId))
          .get();

        let existing: unknown[] = [];
        if (row) {
          try {
            const parsed = JSON.parse(row.messages);
            existing = Array.isArray(parsed) ? (parsed as unknown[]) : [];
          } catch {
            existing = []; // corrupted JSON → start fresh
          }
        }

        const merged = [...existing, ...msgs];
        d.insert(schema.projectionMessages)
          .values({
            threadId,
            messages: JSON.stringify(merged),
            updatedAt: Date.now(),
          })
          .onConflictDoUpdate({
            target: schema.projectionMessages.threadId,
            set: {
              messages: JSON.stringify(merged),
              updatedAt: Date.now(),
            },
          })
          .run();

        db.run("COMMIT");
      } catch (err) {
        db.run("ROLLBACK");
        throw err;
      }
    },
  };
}
