import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
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

export function openBindings(agentId: string, stateRoot: string): Database {
  const dir = join(stateRoot, "lark-bot", safeAgentId(agentId));
  mkdirSync(dir, { recursive: true });
  const dbfile = join(dir, "bindings.sqlite");
  const db = new Database(dbfile);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
  ensureSchema(db);
  return db;
}

function ensureSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_binding (
      lark_chat_id    TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      chat_type       TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      pushed_seq      INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS member_binding (
      lark_chat_id    TEXT NOT NULL,
      lark_open_id    TEXT NOT NULL,
      member_id       TEXT NOT NULL,
      PRIMARY KEY (lark_chat_id, lark_open_id)
    );
    CREATE TABLE IF NOT EXISTS inbound_message (
      lark_event_id   TEXT PRIMARY KEY,
      lark_message_id TEXT NOT NULL,
      lark_chat_id    TEXT NOT NULL,
      conversation_id TEXT,
      ledger_seq      INTEGER,
      status          TEXT NOT NULL DEFAULT 'processing',
      created_at      INTEGER NOT NULL,
      UNIQUE(lark_message_id)
    );
  `);
}

export function getChatBinding(db: Database, larkChatId: string): ChatBinding | null {
  const row = db
    .query(
      "SELECT lark_chat_id, conversation_id, chat_type, created_at, pushed_seq FROM chat_binding WHERE lark_chat_id = ?",
    )
    .get(larkChatId) as
    | {
        lark_chat_id: string;
        conversation_id: string;
        chat_type: string;
        created_at: number;
        pushed_seq: number;
      }
    | undefined;
  if (!row) return null;
  return {
    larkChatId: row.lark_chat_id,
    conversationId: row.conversation_id,
    chatType: row.chat_type,
    createdAt: row.created_at,
    pushedSeq: row.pushed_seq,
  };
}

export function getAllChatBindings(db: Database): ChatBinding[] {
  const rows = db
    .query(
      "SELECT lark_chat_id, conversation_id, chat_type, created_at, pushed_seq FROM chat_binding",
    )
    .all() as {
    lark_chat_id: string;
    conversation_id: string;
    chat_type: string;
    created_at: number;
    pushed_seq: number;
  }[];
  return rows.map((row) => ({
    larkChatId: row.lark_chat_id,
    conversationId: row.conversation_id,
    chatType: row.chat_type,
    createdAt: row.created_at,
    pushedSeq: row.pushed_seq,
  }));
}

export function putChatBinding(
  db: Database,
  larkChatId: string,
  conversationId: string,
  chatType: string,
  createdAt: number,
): void {
  db.run(
    "INSERT OR REPLACE INTO chat_binding (lark_chat_id, conversation_id, chat_type, created_at, pushed_seq) VALUES (?, ?, ?, ?, 0)",
    [larkChatId, conversationId, chatType, createdAt],
  );
}

export function updatePushedSeq(db: Database, larkChatId: string, seq: number): void {
  db.run("UPDATE chat_binding SET pushed_seq = ? WHERE lark_chat_id = ?", [seq, larkChatId]);
}

export function getMemberBinding(
  db: Database,
  larkChatId: string,
  larkOpenId: string,
): string | null {
  const row = db
    .query("SELECT member_id FROM member_binding WHERE lark_chat_id = ? AND lark_open_id = ?")
    .get(larkChatId, larkOpenId) as { member_id: string } | undefined;
  return row?.member_id ?? null;
}

export function putMemberBinding(
  db: Database,
  larkChatId: string,
  larkOpenId: string,
  memberId: string,
): void {
  db.run(
    "INSERT OR IGNORE INTO member_binding (lark_chat_id, lark_open_id, member_id) VALUES (?, ?, ?)",
    [larkChatId, larkOpenId, memberId],
  );
}

export function getMemberBindingsForChat(db: Database, larkChatId: string): MemberBinding[] {
  const rows = db
    .query(
      "SELECT lark_chat_id, lark_open_id, member_id FROM member_binding WHERE lark_chat_id = ?",
    )
    .all(larkChatId) as { lark_chat_id: string; lark_open_id: string; member_id: string }[];
  return rows.map((row) => ({
    larkChatId: row.lark_chat_id,
    larkOpenId: row.lark_open_id,
    memberId: row.member_id,
  }));
}

// ─── inbound_message (reserve → confirm flow, see spec §4.3) ───

export function inboundExists(db: Database, larkEventId: string, larkMessageId: string): boolean {
  const row = db
    .query("SELECT 1 FROM inbound_message WHERE lark_event_id = ? OR lark_message_id = ?")
    .get(larkEventId, larkMessageId) as unknown;
  return !!row;
}

export function reserveInbound(
  db: Database,
  eventId: string,
  messageId: string,
  chatId: string,
): void {
  db.run(
    "INSERT INTO inbound_message (lark_event_id, lark_message_id, lark_chat_id, status, created_at) VALUES (?, ?, ?, 'processing', ?)",
    [eventId, messageId, chatId, Date.now()],
  );
}

export function confirmInbound(
  db: Database,
  eventId: string,
  conversationId: string,
  ledgerSeq: number,
): void {
  db.run(
    "UPDATE inbound_message SET conversation_id = ?, ledger_seq = ?, status = 'posted' WHERE lark_event_id = ?",
    [conversationId, ledgerSeq, eventId],
  );
}
