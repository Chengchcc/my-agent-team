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
    CREATE TABLE IF NOT EXISTS run_stream (
      run_id              TEXT PRIMARY KEY,
      lark_chat_id        TEXT NOT NULL,
      conversation_id     TEXT NOT NULL,
      lark_message_id     TEXT,
      source_message_id   TEXT,
      typing_reaction_id  TEXT,
      typing_status       TEXT NOT NULL DEFAULT 'none',
      status              TEXT NOT NULL DEFAULT 'starting',
      accumulated         TEXT NOT NULL DEFAULT '',
      card_send_failed    INTEGER NOT NULL DEFAULT 0,
      card_update_failed  INTEGER NOT NULL DEFAULT 0,
      final_ledger_seq    INTEGER,
      last_error          TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
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

// ─── run_stream (M15.1: card streaming state) ───

export interface RunStreamRecord {
  runId: string;
  larkChatId: string;
  conversationId: string;
  larkMessageId: string | null;
  sourceMessageId: string | null;
  typingReactionId: string | null;
  typingStatus: "none" | "active" | "removed" | "failed";
  status: "starting" | "streaming" | "done" | "error" | "fallback_text";
  accumulated: string;
  cardSendFailed: number;
  cardUpdateFailed: number;
  finalLedgerSeq: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export function canSkipFinalLedgerText(run: RunStreamRecord): boolean {
  return (
    run.status === "done" &&
    !!run.larkMessageId &&
    run.cardSendFailed === 0 &&
    run.cardUpdateFailed === 0
  );
}

export function insertRunStream(db: Database, rec: RunStreamRecord): void {
  db.run(
    `INSERT INTO run_stream (run_id, lark_chat_id, conversation_id, lark_message_id,
      source_message_id, typing_reaction_id, typing_status, status, accumulated,
      card_send_failed, card_update_failed, final_ledger_seq, last_error,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      rec.runId, rec.larkChatId, rec.conversationId, rec.larkMessageId,
      rec.sourceMessageId, rec.typingReactionId, rec.typingStatus, rec.status,
      rec.accumulated, rec.cardSendFailed, rec.cardUpdateFailed,
      rec.finalLedgerSeq, rec.lastError, rec.createdAt, rec.updatedAt,
    ],
  );
}

export function getRunStream(db: Database, runId: string): RunStreamRecord | null {
  const row = db
    .query("SELECT * FROM run_stream WHERE run_id = ?")
    .get(runId) as RunStreamDbRow | undefined;
  return row ? toRunStreamRecord(row) : null;
}

export function getRunStreamsByChat(db: Database, larkChatId: string): RunStreamRecord[] {
  const rows = db
    .query("SELECT * FROM run_stream WHERE lark_chat_id = ?")
    .all(larkChatId) as RunStreamDbRow[];
  return rows.map(toRunStreamRecord);
}

export function getRunStreamsByConversation(
  db: Database,
  conversationId: string,
): RunStreamRecord[] {
  const rows = db
    .query("SELECT * FROM run_stream WHERE conversation_id = ?")
    .all(conversationId) as RunStreamDbRow[];
  return rows.map(toRunStreamRecord);
}

export function getAllRunStreams(db: Database): RunStreamRecord[] {
  const rows = db.query("SELECT * FROM run_stream").all() as RunStreamDbRow[];
  return rows.map(toRunStreamRecord);
}

export function updateRunStream(
  db: Database,
  runId: string,
  partial: Partial<RunStreamRecord>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (partial.larkMessageId !== undefined) { fields.push("lark_message_id = ?"); values.push(partial.larkMessageId); }
  if (partial.typingReactionId !== undefined) { fields.push("typing_reaction_id = ?"); values.push(partial.typingReactionId); }
  if (partial.typingStatus !== undefined) { fields.push("typing_status = ?"); values.push(partial.typingStatus); }
  if (partial.status !== undefined) { fields.push("status = ?"); values.push(partial.status); }
  if (partial.accumulated !== undefined) { fields.push("accumulated = ?"); values.push(partial.accumulated); }
  if (partial.cardSendFailed !== undefined) { fields.push("card_send_failed = ?"); values.push(partial.cardSendFailed); }
  if (partial.cardUpdateFailed !== undefined) { fields.push("card_update_failed = ?"); values.push(partial.cardUpdateFailed); }
  if (partial.finalLedgerSeq !== undefined) { fields.push("final_ledger_seq = ?"); values.push(partial.finalLedgerSeq); }
  if (partial.lastError !== undefined) { fields.push("last_error = ?"); values.push(partial.lastError); }
  if (fields.length === 0) return;
  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(runId);
  db.run(`UPDATE run_stream SET ${fields.join(", ")} WHERE run_id = ?`, values as Parameters<typeof db.run>[1]);
}

// ─── M15.1: Rebind chat to a new conversation ───

export function rebindChatConversation(
  db: Database,
  larkChatId: string,
  oldConversationId: string,
  newConversationId: string,
): boolean {
  const result = db.run(
    "UPDATE chat_binding SET conversation_id = ?, pushed_seq = 0 WHERE lark_chat_id = ? AND conversation_id = ?",
    [newConversationId, larkChatId, oldConversationId],
  );
  return result.changes > 0;
}

// ─── Internal helpers ───

interface RunStreamDbRow {
  run_id: string;
  lark_chat_id: string;
  conversation_id: string;
  lark_message_id: string | null;
  source_message_id: string | null;
  typing_reaction_id: string | null;
  typing_status: string;
  status: string;
  accumulated: string;
  card_send_failed: number;
  card_update_failed: number;
  final_ledger_seq: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

function toRunStreamRecord(row: RunStreamDbRow): RunStreamRecord {
  return {
    runId: row.run_id,
    larkChatId: row.lark_chat_id,
    conversationId: row.conversation_id,
    larkMessageId: row.lark_message_id,
    sourceMessageId: row.source_message_id,
    typingReactionId: row.typing_reaction_id,
    typingStatus: row.typing_status as RunStreamRecord["typingStatus"],
    status: row.status as RunStreamRecord["status"],
    accumulated: row.accumulated,
    cardSendFailed: row.card_send_failed,
    cardUpdateFailed: row.card_update_failed,
    finalLedgerSeq: row.final_ledger_seq,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
