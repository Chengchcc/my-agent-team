import { integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";

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

