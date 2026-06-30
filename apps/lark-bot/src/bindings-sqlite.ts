import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path, { join } from "node:path";
import { and, eq, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./db/schema.js";
import { safeAgentId } from "./safe-agent-id.js";

export interface ChatBinding {
  larkChatId: string;
  conversationId: string;
  chatType: string;
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

// ─── chat_binding ──────────────────────────────────────────────────

export function getChatBinding(db: Database, larkChatId: string): ChatBinding | null {
  const row = d(db)
    .select()
    .from(schema.chatBinding)
    .where(eq(schema.chatBinding.larkChatId, larkChatId))
    .get();
  if (!row) return null;
  return {
    larkChatId: row.larkChatId,
    conversationId: row.conversationId,
    chatType: row.chatType,
    createdAt: row.createdAt,
    pushedSeq: row.pushedSeq,
  };
}

export function getAllChatBindings(db: Database): ChatBinding[] {
  return d(db)
    .select()
    .from(schema.chatBinding)
    .all()
    .map((row) => ({
      larkChatId: row.larkChatId,
      conversationId: row.conversationId,
      chatType: row.chatType,
      createdAt: row.createdAt,
      pushedSeq: row.pushedSeq,
    }));
}

export function putChatBinding(
  db: Database,
  larkChatId: string,
  conversationId: string,
  chatType: string,
  createdAt: number,
): void {
  d(db)
    .insert(schema.chatBinding)
    .values({ larkChatId, conversationId, chatType, createdAt, pushedSeq: 0 })
    .onConflictDoUpdate({
      target: schema.chatBinding.larkChatId,
      set: { conversationId, chatType },
    })
    .run();
}

export function updatePushedSeq(db: Database, larkChatId: string, seq: number): void {
  d(db)
    .update(schema.chatBinding)
    .set({ pushedSeq: seq })
    .where(eq(schema.chatBinding.larkChatId, larkChatId))
    .run();
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
  conversationId: string,
  ledgerSeq: number,
): void {
  d(db)
    .update(schema.inboundMessage)
    .set({ conversationId, ledgerSeq, status: "posted" })
    .where(eq(schema.inboundMessage.larkEventId, eventId))
    .run();
}

// ─── Rebind chat to a new conversation ─────────────────────────────

export function rebindChatConversation(
  db: Database,
  larkChatId: string,
  oldConversationId: string,
  newConversationId: string,
): boolean {
  const result = d(db)
    .update(schema.chatBinding)
    .set({ conversationId: newConversationId, pushedSeq: 0 })
    .where(
      and(
        eq(schema.chatBinding.larkChatId, larkChatId),
        eq(schema.chatBinding.conversationId, oldConversationId),
      ),
    )
    .run();
  // drizzle-orm 0.44 types .run() as void for SQLite; runtime returns { changes }.
  return (result as unknown as { changes: number }).changes > 0;
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
