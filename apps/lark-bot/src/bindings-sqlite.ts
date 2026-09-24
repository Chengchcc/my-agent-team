import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path, { join } from "node:path";
import { and, eq, notInArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./db/schema.js";
import { safeAgentId } from "./safe-agent-id.js";

/** One backend conversation and the Lark chat it is delivered to. Keyed by
 *  conversation, not chat (ADR 0037): a chat holds one conversation per topic,
 *  so the delivery cursor belongs to the conversation. */
export interface ConversationBinding {
  conversationId: string;
  larkChatId: string;
  chatType: string;
  /** Lark `chat_mode` ("group" | "topic"); null until looked up. A topic chat
   *  needs `reply_in_thread` when we answer, a normal one rejects it. */
  chatMode: string | null;
  createdAt: number;
  pushedSeq: number;
}

export interface MemberBinding {
  larkChatId: string;
  larkOpenId: string;
  memberId: string;
}

export interface InboundRecord {
  larkEventId: string;
  larkMessageId: string;
  larkChatId: string;
  conversationId: string | null;
  ledgerSeq: number | null;
  status: string;
}

// ─── Connection ────────────────────────────────────────────────────

export function openBindings(agentId: string, stateRoot: string): Database {
  const dir = join(stateRoot, "lark-bot", safeAgentId(agentId));
  mkdirSync(dir, { recursive: true });
  const dbfile = join(dir, "bindings.sqlite");
  const db = new Database(dbfile);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");

  // M20: drizzle-kit migrate replaces ensureSchema() DDL + migrateRunStreamSchema() ALTER hack.
  const d = drizzle(db, { schema, casing: "snake_case" });
  const migrationsFolder = path.resolve(import.meta.dirname, "../drizzle");
  migrate(d, { migrationsFolder });

  return db;
}

// ─── Helpers ───────────────────────────────────────────────────────

function d(db: Database) {
  return drizzle(db, { schema, casing: "snake_case" });
}

// ─── conversation_binding (ADR 0037) ──────────────────────────────

function toConversationBinding(
  row: typeof schema.conversationBinding.$inferSelect,
): ConversationBinding {
  return {
    conversationId: row.conversationId,
    larkChatId: row.larkChatId,
    chatType: row.chatType,
    chatMode: row.chatMode,
    createdAt: row.createdAt,
    pushedSeq: row.pushedSeq,
  };
}

export function getConversationBinding(
  db: Database,
  conversationId: string,
): ConversationBinding | null {
  const row = d(db)
    .select()
    .from(schema.conversationBinding)
    .where(eq(schema.conversationBinding.conversationId, conversationId))
    .get();
  return row ? toConversationBinding(row) : null;
}

export function listConversationBindings(db: Database): ConversationBinding[] {
  return d(db).select().from(schema.conversationBinding).all().map(toConversationBinding);
}

/** Insert a conversation's binding. Conflict = it already exists (restart,
 *  rebind race): keep the stored cursor, never reset it. */
export function putConversationBinding(db: Database, binding: ConversationBinding): void {
  d(db)
    .insert(schema.conversationBinding)
    .values({
      conversationId: binding.conversationId,
      larkChatId: binding.larkChatId,
      chatType: binding.chatType,
      chatMode: binding.chatMode,
      pushedSeq: binding.pushedSeq,
      createdAt: binding.createdAt,
    })
    .onConflictDoNothing()
    .run();
}

export function updateChatMode(db: Database, conversationId: string, chatMode: string): void {
  d(db)
    .update(schema.conversationBinding)
    .set({ chatMode })
    .where(eq(schema.conversationBinding.conversationId, conversationId))
    .run();
}

export function updatePushedSeq(db: Database, conversationId: string, seq: number): void {
  d(db)
    .update(schema.conversationBinding)
    .set({ pushedSeq: seq })
    .where(eq(schema.conversationBinding.conversationId, conversationId))
    .run();
}

/** Does this chat already hold a conversation? The access policy reads it to
 *  keep an in-use chat answering after the group default became "not
 *  answered" (ADR 0034) — under ADR 0037 "in use" means "any topic bound". */
export function chatHasConversations(db: Database, larkChatId: string): boolean {
  const row = d(db)
    .select({ conversationId: schema.conversationBinding.conversationId })
    .from(schema.conversationBinding)
    .where(eq(schema.conversationBinding.larkChatId, larkChatId))
    .limit(1)
    .get();
  return row !== undefined;
}

// ─── topic_binding (ADR 0037: which Lark object identifies a topic) ──

export function findConversationByTopicKey(
  db: Database,
  larkChatId: string,
  topicKey: string,
): string | null {
  const row = d(db)
    .select({ conversationId: schema.topicBinding.conversationId })
    .from(schema.topicBinding)
    .where(
      and(
        eq(schema.topicBinding.larkChatId, larkChatId),
        eq(schema.topicBinding.topicKey, topicKey),
      ),
    )
    .get();
  return row?.conversationId ?? null;
}

/** Remember that these Lark objects all identify one conversation's topic.
 *  Called on BOTH paths: when opening a topic (record the message id a later
 *  reply will point at) and when resolving one (learn the `thread_id` Lark
 *  assigns to a p2p reply chain only after the first reply). Idempotent, and a
 *  key already owned by another conversation is left with its owner. */
export function rememberTopicKeys(
  db: Database,
  larkChatId: string,
  conversationId: string,
  keys: readonly string[],
  createdAt: number,
): void {
  for (const key of keys) {
    if (!key) continue;
    d(db)
      .insert(schema.topicBinding)
      .values({ larkChatId, topicKey: key, conversationId, createdAt })
      .onConflictDoNothing()
      .run();
  }
}

/** Topic keys mapped to a conversation, oldest first — the topic's own root
 *  was recorded when it opened, so the caller that needs a reply target
 *  (a MESSAGE id, not a thread id) finds the root before any later key. */
export function listTopicKeys(db: Database, larkChatId: string, conversationId: string): string[] {
  return d(db)
    .select({ topicKey: schema.topicBinding.topicKey })
    .from(schema.topicBinding)
    .where(
      and(
        eq(schema.topicBinding.larkChatId, larkChatId),
        eq(schema.topicBinding.conversationId, conversationId),
      ),
    )
    .orderBy(schema.topicBinding.createdAt, schema.topicBinding.topicKey)
    .all()
    .map((row) => row.topicKey);
}

// ─── member_binding ────────────────────────────────────────────────

export function getMemberBinding(
  db: Database,
  larkChatId: string,
  larkOpenId: string,
): string | null {
  const row = d(db)
    .select({ memberId: schema.memberBinding.memberId })
    .from(schema.memberBinding)
    .where(
      and(
        eq(schema.memberBinding.larkChatId, larkChatId),
        eq(schema.memberBinding.larkOpenId, larkOpenId),
      ),
    )
    .get();
  return row?.memberId ?? null;
}

export function putMemberBinding(
  db: Database,
  larkChatId: string,
  larkOpenId: string,
  memberId: string,
): void {
  d(db)
    .insert(schema.memberBinding)
    .values({ larkChatId, larkOpenId, memberId })
    .onConflictDoNothing()
    .run();
}

export function getMemberBindingsForChat(db: Database, larkChatId: string): MemberBinding[] {
  return d(db)
    .select()
    .from(schema.memberBinding)
    .where(eq(schema.memberBinding.larkChatId, larkChatId))
    .all()
    .map((row) => ({
      larkChatId: row.larkChatId,
      larkOpenId: row.larkOpenId,
      memberId: row.memberId,
    }));
}

// ─── inbound_message (reserve → confirm flow) ──────────────────────

export function inboundExists(db: Database, larkEventId: string, larkMessageId: string): boolean {
  const row = d(db)
    .select({ one: schema.inboundMessage.larkEventId })
    .from(schema.inboundMessage)
    .where(
      or(
        eq(schema.inboundMessage.larkEventId, larkEventId),
        eq(schema.inboundMessage.larkMessageId, larkMessageId),
      ),
    )
    .get();
  return row !== undefined;
}

export function reserveInbound(
  db: Database,
  eventId: string,
  messageId: string,
  chatId: string,
): void {
  d(db)
    .insert(schema.inboundMessage)
    .values({
      larkEventId: eventId,
      larkMessageId: messageId,
      larkChatId: chatId,
      status: "processing",
      createdAt: Date.now(),
    })
    .run();
}

export function confirmInbound(
  db: Database,
  eventId: string,
  conversationId: string | null,
  ledgerSeq: number | null,
): void {
  d(db)
    .update(schema.inboundMessage)
    .set({ conversationId, ledgerSeq, status: "posted" })
    .where(eq(schema.inboundMessage.larkEventId, eventId))
    .run();
}

// ─── Rebind a conversation (backend fork / kind switch) ─────────────

/** The backend forked the branch into a new conversation id: move the binding
 *  and its topic keys across, and start the cursor at 0 (a fork has its own
 *  ledger). Topic keys must move with it — otherwise the next reply in the
 *  same Lark topic would open a NEW conversation instead of following. */
export function rebindConversation(
  db: Database,
  oldConversationId: string,
  newConversationId: string,
): boolean {
  return db.transaction(() => {
    const moved = d(db)
      .update(schema.conversationBinding)
      .set({ conversationId: newConversationId, pushedSeq: 0 })
      .where(eq(schema.conversationBinding.conversationId, oldConversationId))
      .run();
    // drizzle-orm 0.44 types .run() as void for SQLite; runtime returns { changes }.
    const changes = (moved as unknown as { changes: number }).changes;
    if (changes === 0) return false;
    d(db)
      .update(schema.topicBinding)
      .set({ conversationId: newConversationId })
      .where(eq(schema.topicBinding.conversationId, oldConversationId))
      .run();
    return true;
  })();
}

// ─── Message delivery tracking ─────────────────────────────────────

export interface MessageDeliveryRecord {
  conversationId: string;
  messageId: string;
  larkChatId: string;
  lastState: string;
  lastSeq: number;
  updatedAt: number;
}

/** Deliveries still in flight: rows whose last state is not terminal
 *  (`done`/`error`). The bot reports this in its heartbeat, so the Lark
 *  surface view can say whether it is holding messages it could not send —
 *  a number the wizard otherwise has no way to see. */
export function countPendingDeliveries(db: Database): number {
  return d(db)
    .select({ messageId: schema.messageDelivery.messageId })
    .from(schema.messageDelivery)
    .where(notInArray(schema.messageDelivery.lastState, ["done", "error"]))
    .all().length;
}

export function getMessageDelivery(
  db: Database,
  conversationId: string,
  messageId: string,
  larkChatId: string,
): MessageDeliveryRecord | null {
  const row = d(db)
    .select()
    .from(schema.messageDelivery)
    .where(
      and(
        eq(schema.messageDelivery.conversationId, conversationId),
        eq(schema.messageDelivery.messageId, messageId),
        eq(schema.messageDelivery.larkChatId, larkChatId),
      ),
    )
    .get();
  if (!row) return null;
  return {
    conversationId: row.conversationId,
    messageId: row.messageId,
    larkChatId: row.larkChatId,
    lastState: row.lastState,
    lastSeq: row.lastSeq,
    updatedAt: row.updatedAt,
  };
}

export function upsertMessageDelivery(db: Database, rec: MessageDeliveryRecord): void {
  d(db)
    .insert(schema.messageDelivery)
    .values({
      conversationId: rec.conversationId,
      messageId: rec.messageId,
      larkChatId: rec.larkChatId,
      lastState: rec.lastState,
      lastSeq: rec.lastSeq,
      updatedAt: rec.updatedAt,
    })
    .onConflictDoUpdate({
      target: [
        schema.messageDelivery.conversationId,
        schema.messageDelivery.messageId,
        schema.messageDelivery.larkChatId,
      ],
      set: {
        lastState: rec.lastState,
        lastSeq: rec.lastSeq,
        updatedAt: rec.updatedAt,
      },
    })
    .run();
}

// ─── run_card (ADR 0031: Lark Run card delivery state) ────────────

export interface RunCardRecord {
  runId: string;
  conversationId: string;
  larkChatId: string;
  larkMessageId: string | null;
  /** The CardKit card entity the hot path streams into. */
  cardKitId: string | null;
  /** Strictly increasing per card — CardKit stream/replace ordering. */
  cardSeq: number;
  sourceMessageId: string | null;
  /** "OnIt" reaction on the user's message while the run is live. */
  ackReactionId: string | null;
  status: string;
  accumulated: string;
  toolCount: number;
  cardSendFailed: number;
  cardUpdateFailed: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Statuses that still own the run's UX (card alive or about to seal). */
const RUN_CARD_ACTIVE_STATUSES: Record<string, true> = {
  creating: true,
  streaming: true,
  waiting: true,
};

function parseRunCard(row: typeof schema.runCard.$inferSelect): RunCardRecord {
  return {
    runId: row.runId,
    conversationId: row.conversationId,
    larkChatId: row.larkChatId,
    larkMessageId: row.larkMessageId,
    cardKitId: row.cardKitId,
    cardSeq: row.cardSeq,
    sourceMessageId: row.sourceMessageId,
    ackReactionId: row.ackReactionId,
    status: row.status,
    accumulated: row.accumulated,
    toolCount: row.toolCount,
    cardSendFailed: row.cardSendFailed,
    cardUpdateFailed: row.cardUpdateFailed,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function getRunCard(db: Database, runId: string): RunCardRecord | null {
  const row = d(db).select().from(schema.runCard).where(eq(schema.runCard.runId, runId)).get();
  return row ? parseRunCard(row) : null;
}

export function insertRunCard(
  db: Database,
  rec: {
    runId: string;
    conversationId: string;
    larkChatId: string;
    sourceMessageId: string | null;
  },
): void {
  const now = Date.now();
  d(db)
    .insert(schema.runCard)
    .values({ ...rec, status: "creating", createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: schema.runCard.runId,
      set: { conversationId: rec.conversationId, updatedAt: now },
    })
    .run();
}

export function updateRunCard(
  db: Database,
  runId: string,
  patch: Partial<Omit<RunCardRecord, "runId" | "createdAt">>,
): void {
  d(db)
    .update(schema.runCard)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(schema.runCard.runId, runId))
    .run();
}

/** Cards for one chat that are still live (for /stop). */
export function listActiveRunCards(db: Database, larkChatId: string): RunCardRecord[] {
  return d(db)
    .select()
    .from(schema.runCard)
    .where(eq(schema.runCard.larkChatId, larkChatId))
    .all()
    .map(parseRunCard)
    .filter((c) => RUN_CARD_ACTIVE_STATUSES[c.status] === true);
}

/** The active card carried by one Lark message (reaction-triggered stop). */
export function getActiveRunCardByLarkMessage(
  db: Database,
  larkMessageId: string,
): RunCardRecord | null {
  const row = d(db)
    .select()
    .from(schema.runCard)
    .where(eq(schema.runCard.larkMessageId, larkMessageId))
    .get();
  if (!row) return null;
  const card = parseRunCard(row);
  return RUN_CARD_ACTIVE_STATUSES[card.status] === true ? card : null;
}

/** Non-terminal cards to re-drive after a bot restart. */
export function listNonTerminalRunCards(db: Database): RunCardRecord[] {
  return d(db)
    .select()
    .from(schema.runCard)
    .all()
    .map(parseRunCard)
    .filter((c) => RUN_CARD_ACTIVE_STATUSES[c.status] === true);
}

/** ADR 0031 §8 dedup seam: does a card own this run's delivery for this
 * chat? Terminal cards count too — the card already showed the final
 * answer; only `fallback_text` hands delivery back to the text bridge. */
export function runCardOwnsDelivery(db: Database, runId: string, larkChatId: string): boolean {
  const row = d(db)
    .select()
    .from(schema.runCard)
    .where(and(eq(schema.runCard.runId, runId), eq(schema.runCard.larkChatId, larkChatId)))
    .get();
  if (!row) return false;
  // Every stored status except fallback_text means the card showed (or will
  // seal) the run's final answer itself.
  return row.status !== "fallback_text";
}

/** `run:<runId>:assistant:<ordinal>` → runId (assistantMessageId format). */
export function runIdFromMessageId(messageId: string): string | null {
  if (!messageId.startsWith("run:")) return null;
  const runId = messageId.split(":")[1];
  return runId && runId.length > 0 ? runId : null;
}
