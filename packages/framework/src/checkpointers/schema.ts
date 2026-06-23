import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// ─── checkpoint_messages ───────────────────────────────────────────
export const checkpointMessages = sqliteTable("checkpoint_messages", {
  threadId: text("thread_id").primaryKey(),
  messages: text("messages").notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

// ─── checkpoint_interrupts ─────────────────────────────────────────
export const checkpointInterrupts = sqliteTable("checkpoint_interrupts", {
  threadId: text("thread_id").primaryKey(),
  state: text("state").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
});

// ─── checkpoint_events ─────────────────────────────────────────────
export const checkpointEvents = sqliteTable(
  "checkpoint_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    threadId: text("thread_id").notNull(),
    event: text("event").notNull(),
    ts: integer("ts", { mode: "number" }).notNull(),
  },
  (table) => [index("idx_checkpoint_events_thread").on(table.threadId, table.id)],
);
