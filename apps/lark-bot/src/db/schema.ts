import { integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

/** ADR 0037: one backend conversation, delivered to one Lark chat. Keyed by
 *  the CONVERSATION, not the chat: a chat now holds one conversation per
 *  topic, and the delivery cursor must belong to a conversation (a chat-level
 *  cursor would be shared by every topic in it). */
export const conversationBinding = sqliteTable("conversation_binding", {
  conversationId: text().primaryKey(),
  larkChatId: text().notNull(),
  chatType: text().notNull(),
  /** `chat_mode` of the Lark chat ("group" | "topic" | "p2p"): a topic chat
   *  needs `reply_in_thread` when we answer, a normal one does not. Fetched
   *  once per chat, not per message. */
  chatMode: text(),
  pushedSeq: integer().notNull().default(0),
  createdAt: integer({ mode: "number" }).notNull(),
});

/** Which Lark objects identify a conversation's topic (ADR 0037). `topicKey`
 *  is either a thread id (`omt_…` — a topic-chat topic, or a p2p reply chain
 *  after Lark assigns one) or a message id (`om_…` — a topic-chat top-level
 *  message, or one of OUR messages that the user replied to).
 *
 *  One conversation has MANY keys: a p2p reply arrives carrying `root_id`
 *  first and only later gets its `thread_id`, and both must resolve to the
 *  same conversation — hence a mapping table instead of a column. */
export const topicBinding = sqliteTable(
  "topic_binding",
  {
    larkChatId: text().notNull(),
    topicKey: text().notNull(),
    conversationId: text().notNull(),
    createdAt: integer({ mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.larkChatId, table.topicKey] })],
);

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
  /** The IM message that carries the card (sent by card_id reference). */
  larkMessageId: text(),
  /** The CardKit card entity the hot path streams into. */
  cardKitId: text(),
  /** Strictly increasing per card — CardKit stream/replace ordering. */
  cardSeq: integer().notNull().default(0),
  sourceMessageId: text(),
  /** The "OnIt" reaction this bot put on the user's message while the run is
   *  live, so the terminal step can take it back and leave a "DONE". Kept on
   *  the row (not in memory) because a restart mid-run must still be able to
   *  clean up the acknowledgement it left behind. */
  ackReactionId: text(),
  status: text().notNull().default("creating"),
  accumulated: text().notNull().default(""),
  toolCount: integer().notNull().default(0),
  cardSendFailed: integer().notNull().default(0),
  cardUpdateFailed: integer().notNull().default(0),
  lastError: text(),
  createdAt: integer({ mode: "number" }).notNull(),
  updatedAt: integer({ mode: "number" }).notNull(),
});
