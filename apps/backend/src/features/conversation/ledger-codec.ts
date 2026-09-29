import { z } from "zod";

// ─── Ledger codec (backend-internal storage shape) ───────────────────
// 1:1 collapse (spec 2026-08-25): LedgerEntry is the conversation_ledger
// storage row, not a wire contract. The SSE boundary maps it to
// ConversationEvent (api-contract) before it leaves the backend.

/** 存储层的 kind。只保留有写入方的值：`member.joined` / `member.left`（成员表已删）
 *  与 `todo`（从来没有写入方）是历史残留，删掉以免它们继续冒充账本契约的一部分。 */
export const LedgerKind = z.enum(["message", "surface.control", "undo"]);

export type LedgerKind = z.infer<typeof LedgerKind>;

export const LedgerEntry = z.object({
  seq: z.number(),
  conversationId: z.string(),
  senderMemberId: z.string(),
  addressedTo: z.array(z.string()).default([]),
  kind: LedgerKind,
  // Serialized string on the live push path; parsed object when read back
  // through the drizzle select schema. Callers normalize before use.
  content: z.unknown(),
  ts: z.number(),
  /** Soft-delete flag (fork/undo): logically removed, ledger stays append-only. */
  undone: z.boolean().optional(),
});

export type LedgerEntry = z.infer<typeof LedgerEntry>;
