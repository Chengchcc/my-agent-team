import type { Database } from "bun:sqlite";
import type {
  AppendLedgerInput,
  ConversationPort,
  ConversationRow,
  CreateConversationInput,
  CreateMemberInput,
  LedgerRow,
  MemberRow,
} from "./ports.js";

export function sqliteConversationAdapter(db: Database): ConversationPort {
  return {
    // ─── Conversation ──────────────────────────────

    createConversation(input: CreateConversationInput): ConversationRow {
      db.run(
        "INSERT INTO conversation (conversation_id, trigger_mode, hop_count, created_at) VALUES (?, ?, 0, ?)",
        [input.conversationId, input.triggerMode ?? "mention", input.createdAt],
      );
      return {
        conversationId: input.conversationId,
        triggerMode: input.triggerMode ?? "mention",
        hopCount: 0,
        createdAt: input.createdAt,
        title: null,
      };
    },

    getConversation(conversationId: string): ConversationRow | null {
      const row = db
        .query(
          "SELECT conversation_id, trigger_mode, hop_count, created_at, title FROM conversation WHERE conversation_id = ?",
        )
        .get(conversationId) as
        | { conversation_id: string; trigger_mode: string; hop_count: number; created_at: number; title: string | null }
        | undefined;
      if (!row) return null;
      return {
        conversationId: row.conversation_id,
        triggerMode: row.trigger_mode,
        hopCount: row.hop_count,
        createdAt: row.created_at,
        title: row.title,
      };
    },

    setConversationTitle(conversationId: string, title: string): void {
      db.run("UPDATE conversation SET title = ? WHERE conversation_id = ?", [title, conversationId]);
    },

    updateHopCount(conversationId: string, count: number): void {
      db.run("UPDATE conversation SET hop_count = ? WHERE conversation_id = ?", [
        count,
        conversationId,
      ]);
    },

    // ─── Member ────────────────────────────────────

    addMember(input: CreateMemberInput): MemberRow {
      // INSERT OR IGNORE: if the same agent is already a member, silently no-op
      // (invariant: agent memberId equals agentId, so duplicates are naturally prevented)
      db.run(
        "INSERT OR IGNORE INTO member (member_id, conversation_id, kind, agent_id, user_ref, display_name, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          input.memberId,
          input.conversationId,
          input.kind,
          input.agentId ?? null,
          input.userRef ?? null,
          input.displayName ?? null,
          input.joinedAt,
        ],
      );
      return {
        memberId: input.memberId,
        conversationId: input.conversationId,
        kind: input.kind,
        agentId: input.agentId ?? null,
        userRef: input.userRef ?? null,
        displayName: input.displayName ?? null,
        joinedAt: input.joinedAt,
      };
    },

    getMembers(conversationId: string): MemberRow[] {
      const rows = db
        .query(
          "SELECT member_id, conversation_id, kind, agent_id, user_ref, display_name, joined_at FROM member WHERE conversation_id = ? ORDER BY joined_at",
        )
        .all(conversationId) as {
        member_id: string;
        conversation_id: string;
        kind: "agent" | "human";
        agent_id: string | null;
        user_ref: string | null;
        display_name: string | null;
        joined_at: number;
      }[];
      return rows.map((r) => ({
        memberId: r.member_id,
        conversationId: r.conversation_id,
        kind: r.kind,
        agentId: r.agent_id,
        userRef: r.user_ref,
        displayName: r.display_name,
        joinedAt: r.joined_at,
      }));
    },

    getAgentMembers(conversationId: string): MemberRow[] {
      return this.getMembers(conversationId).filter((m) => m.kind === "agent");
    },

    removeMember(conversationId: string, memberId: string): boolean {
      const result = db.run("DELETE FROM member WHERE member_id = ? AND conversation_id = ?", [
        memberId,
        conversationId,
      ]);
      return result.changes > 0;
    },

    // ─── Ledger ────────────────────────────────────

    appendLedgerEntry(input: AppendLedgerInput): number {
      const result = db.run(
        "INSERT INTO conversation_ledger (conversation_id, sender_member_id, addressed_to, kind, content, ts) VALUES (?, ?, ?, ?, ?, ?)",
        [
          input.conversationId,
          input.senderMemberId,
          JSON.stringify(input.addressedTo ?? []),
          input.kind,
          input.content,
          input.ts,
        ],
      );
      return Number(result.lastInsertRowid);
    },

    getLedgerEntries(conversationId: string, opts?: { sinceSeq?: number }): LedgerRow[] {
      const since = opts?.sinceSeq ?? 0;
      const rows = db
        .query(
          "SELECT seq, conversation_id, sender_member_id, addressed_to, kind, content, ts FROM conversation_ledger WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC",
        )
        .all(conversationId, since) as {
        seq: number;
        conversation_id: string;
        sender_member_id: string;
        addressed_to: string;
        kind: "message" | "member.joined" | "member.left";
        content: string;
        ts: number;
      }[];
      return rows.map((r) => {
        let addressedTo: string[] = [];
        try {
          addressedTo = JSON.parse(r.addressed_to) as string[];
        } catch {
          addressedTo = [];
        }
        return {
          seq: r.seq,
          conversationId: r.conversation_id,
          senderMemberId: r.sender_member_id,
          addressedTo,
          kind: r.kind,
          content: r.content,
          ts: r.ts,
        };
      });
    },
  };
}
