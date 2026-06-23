import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const checkpointMessages = sqliteTable("checkpoint_messages", {
  threadId: text().primaryKey(),
  messages: text().notNull(),
  updatedAt: integer({ mode: "number" }).notNull(),
});

export const checkpointInterrupts = sqliteTable("checkpoint_interrupts", {
  threadId: text().primaryKey(),
  state: text().notNull(),
  createdAt: integer({ mode: "number" }).notNull(),
});

export const checkpointEvents = sqliteTable(
  "checkpoint_events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    threadId: text().notNull(),
    event: text().notNull(),
    ts: integer({ mode: "number" }).notNull(),
  },
  (table) => [index("idx_checkpoint_events_thread").on(table.threadId, table.id)],
);
