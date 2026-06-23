import { integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

// ─── chat_binding ──────────────────────────────────────────────────
export const chatBinding = sqliteTable("chat_binding", {
  larkChatId: text("lark_chat_id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  chatType: text("chat_type").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  pushedSeq: integer("pushed_seq").notNull().default(0),
});

// ─── member_binding ────────────────────────────────────────────────
export const memberBinding = sqliteTable(
  "member_binding",
  {
    larkChatId: text("lark_chat_id").notNull(),
    larkOpenId: text("lark_open_id").notNull(),
    memberId: text("member_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.larkChatId, table.larkOpenId] })],
);

// ─── inbound_message ───────────────────────────────────────────────
export const inboundMessage = sqliteTable(
  "inbound_message",
  {
    larkEventId: text("lark_event_id").primaryKey(),
    larkMessageId: text("lark_message_id").notNull(),
    larkChatId: text("lark_chat_id").notNull(),
    conversationId: text("conversation_id"),
    ledgerSeq: integer("ledger_seq"),
    status: text("status").notNull().default("processing"),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (table) => [unique("uq_inbound_lark_message_id").on(table.larkMessageId)],
);

// ─── run_stream ────────────────────────────────────────────────────
// 16 columns confirmed — includes complete_from_ledger from M15.1 ALTER migration.
export const runStream = sqliteTable("run_stream", {
  runId: text("run_id").primaryKey(),
  larkChatId: text("lark_chat_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  larkMessageId: text("lark_message_id"),
  sourceMessageId: text("source_message_id"),
  typingReactionId: text("typing_reaction_id"),
  typingStatus: text("typing_status").notNull().default("none"),
  status: text("status").notNull().default("starting"),
  accumulated: text("accumulated").notNull().default(""),
  cardSendFailed: integer("card_send_failed").notNull().default(0),
  cardUpdateFailed: integer("card_update_failed").notNull().default(0),
  finalLedgerSeq: integer("final_ledger_seq"),
  lastError: text("last_error"),
  completeFromLedger: integer("complete_from_ledger").notNull().default(0),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

// ─── message_delivery ──────────────────────────────────────────────
export const messageDelivery = sqliteTable("message_delivery", {
  conversationId: text("conversation_id").notNull(),
  messageId: text("message_id").notNull(),
  larkChatId: text("lark_chat_id").notNull(),
  lastState: text("last_state").notNull().default("streaming"),
  lastSeq: integer("last_seq").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.conversationId, table.messageId, table.larkChatId] }),
]);
