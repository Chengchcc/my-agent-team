import { integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const chatBinding = sqliteTable("chat_binding", {
  larkChatId: text().primaryKey(),
  conversationId: text().notNull(),
  chatType: text().notNull(),
  createdAt: integer({ mode: "number" }).notNull(),
  pushedSeq: integer().notNull().default(0),
});

export const memberBinding = sqliteTable(
  "member_binding",
  {
    larkChatId: text().notNull(),
    larkOpenId: text().notNull(),
    memberId: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.larkChatId, table.larkOpenId] })],
);

export const inboundMessage = sqliteTable(
  "inbound_message",
  {
    larkEventId: text().primaryKey(),
    larkMessageId: text().notNull(),
    larkChatId: text().notNull(),
    conversationId: text(),
    ledgerSeq: integer(),
    status: text().notNull().default("processing"),
    createdAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [unique("uq_inbound_lark_message_id").on(table.larkMessageId)],
);

export const messageDelivery = sqliteTable(
  "message_delivery",
  {
    conversationId: text().notNull(),
    messageId: text().notNull(),
    larkChatId: text().notNull(),
    lastState: text().notNull().default("streaming"),
    lastSeq: integer().notNull().default(0),
    updatedAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.conversationId, table.messageId, table.larkChatId] })],
);

/** ADR 0031: the Lark Run card — a transient projection of one Agent Run.
 * End-side delivery state only (never a backend entity). Terminal rows are
 * kept for the dedup seam; `fallback_text` hands the run's final answer
 * back to the text bridge semantics (the card watcher sends it itself). */
export const runCard = sqliteTable("run_card", {
  runId: text().primaryKey(),
  conversationId: text().notNull(),
  larkChatId: text().notNull(),
  larkMessageId: text(),
  sourceMessageId: text(),
  status: text().notNull().default("creating"),
  accumulated: text().notNull().default(""),
  toolCount: integer().notNull().default(0),
  cardSendFailed: integer().notNull().default(0),
  cardUpdateFailed: integer().notNull().default(0),
  lastError: text(),
  createdAt: integer({ mode: "number" }).notNull(),
  updatedAt: integer({ mode: "number" }).notNull(),
});
