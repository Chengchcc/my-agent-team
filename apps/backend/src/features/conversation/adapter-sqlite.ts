import type { Database } from "bun:sqlite";
import { z } from "zod";
import type {
  AppendLedgerInput,
  ConversationPort,
  ConversationRow,
  ConversationWithMembers,
  CreateConversationInput,
  CreateMemberInput,
  LedgerEntry,
  MemberRow,
} from "./ports.js";

const addressedToSchema = z.array(z.string());

export function sqliteConversationAdapter(db: Database): ConversationPort {
  return {
    // ─── Conversation ──────────────────────────────

    createConversation(input: CreateConversationInput): ConversationRow {
      db.run(
        "INSERT INTO conversation (conversation_id, trigger_mode, hop_count, origin, created_at) VALUES (?, ?, 0, ?, ?)",
        [
          input.conversationId,
          input.triggerMode ?? "mention",
          input.origin ?? "user",
          input.createdAt,
        ],
      );
      return {
        conversationId: input.conversationId,
        triggerMode: input.triggerMode ?? "mention",
        hopCount: 0,
        origin: input.origin ?? "user",
        createdAt: input.createdAt,
        title: null,
      };
    },

    getConversation(conversationId: string): ConversationRow | null {
      const row = db
        .query(
          "SELECT conversation_id, trigger_mode, hop_count, origin, created_at, title FROM conversation WHERE conversation_id = ?",
        )
        .get(conversationId) as
        | {
            conversation_id: string;
            trigger_mode: string;
            hop_count: number;
            origin: string;
            created_at: number;
            title: string | null;
          }
        | undefined;
      if (!row) return null;
      return {
        conversationId: row.conversation_id,
        triggerMode: row.trigger_mode,
        hopCount: row.hop_count,
        origin: row.origin,
        createdAt: row.created_at,
        title: row.title,
      };
    },

    setConversationTitle(conversationId: string, title: string): void {
      db.run("UPDATE conversation SET title = ? WHERE conversation_id = ?", [
        title,
        conversationId,
      ]);
    },

    updateHopCount(conversationId: string, count: number): void {
      db.run("UPDATE conversation SET hop_count = ? WHERE conversation_id = ?", [
        count,
        conversationId,
      ]);
    },

    listConversations(): ConversationWithMembers[] {
      const convs = db
        .query(
          "SELECT conversation_id, trigger_mode, hop_count, origin, created_at, title FROM conversation WHERE origin = 'user' ORDER BY created_at DESC",
        )
        .all() as Array<{
        conversation_id: string;
        trigger_mode: string;
        hop_count: number;
        origin: string;
        created_at: number;
        title: string | null;
      }>;
      return convs.map((c) => ({
        conversationId: c.conversation_id,
        triggerMode: c.trigger_mode,
        hopCount: c.hop_count,
        origin: c.origin,
        createdAt: c.created_at,
        title: c.title,
        members: db
          .query(
            `SELECT member_id AS memberId, conversation_id AS conversationId, kind,
                    agent_id AS agentId, user_ref AS userRef,
                    display_name AS displayName, joined_at AS joinedAt
             FROM member WHERE conversation_id = ?`,
          )
          .all(c.conversation_id) as MemberRow[],
      }));
    },

    deleteConversation(conversationId: string): boolean {
      // Clean up related thread rows first (conversation threads + agent_thread backfill)
      db.run("DELETE FROM threads WHERE id LIKE ?", [`${conversationId}%`]);
      const result = db.run("DELETE FROM conversation WHERE conversation_id = ?", [conversationId]);
      return result.changes > 0;
    },

    listConversationsByAgent(agentId: string): ConversationWithMembers[] {
      const convIds = db
        .query("SELECT DISTINCT conversation_id FROM member WHERE agent_id = ?")
        .all(agentId) as Array<{ conversation_id: string }>;
      return convIds
        .map((r) => {
          const c = db
            .query(
              "SELECT conversation_id, trigger_mode, hop_count, origin, created_at, title FROM conversation WHERE conversation_id = ?",
            )
            .get(r.conversation_id) as
            | {
                conversation_id: string;
                trigger_mode: string;
                hop_count: number;
                origin: string;
                created_at: number;
                title: string | null;
              }
            | undefined;
          if (!c) return null;
          return {
            conversationId: c.conversation_id,
            triggerMode: c.trigger_mode,
            hopCount: c.hop_count,
            origin: c.origin,
            createdAt: c.created_at,
            title: c.title,
            members: db
              .query(
                `SELECT member_id AS memberId, conversation_id AS conversationId, kind,
                        agent_id AS agentId, user_ref AS userRef,
                        display_name AS displayName, joined_at AS joinedAt
                 FROM member WHERE conversation_id = ?`,
              )
              .all(c.conversation_id) as MemberRow[],
          };
        })
        .filter(Boolean) as ConversationWithMembers[];
    },

    // ─── Member ────────────────────────────────────

    addMember(input: CreateMemberInput): { member: MemberRow; created: boolean } {
      // INSERT OR IGNORE: if the same (conversation_id, member_id) already exists,
      // silently no-op. Detect via result.changes to support idempotent addMember.
      const result = db.run(
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
        member: {
          memberId: input.memberId,
          conversationId: input.conversationId,
          kind: input.kind,
          agentId: input.agentId ?? null,
          userRef: input.userRef ?? null,
          displayName: input.displayName ?? null,
          joinedAt: input.joinedAt,
        },
        created: result.changes > 0,
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
        "INSERT INTO conversation_ledger (conversation_id, sender_member_id, addressed_to, kind, content, ts, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          input.conversationId,
          input.senderMemberId,
          JSON.stringify(input.addressedTo ?? []),
          input.kind,
          input.content,
          input.ts,
          input.runId ?? null,
        ],
      );
      return Number(result.lastInsertRowid);
    },

    hasLedgerContent(runId: string, content: string): boolean {
      const row = db
        .query("SELECT 1 FROM conversation_ledger WHERE run_id = ? AND content = ? LIMIT 1")
        .get(runId, content);
      return row !== null;
    },

    getLedgerEntries(conversationId: string, opts?: { sinceSeq?: number }): LedgerEntry[] {
      const since = opts?.sinceSeq ?? 0;
      const rows = db
        .query(
          "SELECT seq, conversation_id, sender_member_id, addressed_to, kind, content, ts, run_id FROM conversation_ledger WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC",
        )
        .all(conversationId, since) as {
        seq: number;
        conversation_id: string;
        sender_member_id: string;
        addressed_to: string;
        kind: "message" | "member.joined" | "member.left" | "todo" | "surface.control";
        content: string;
        ts: number;
        run_id: string | null;
      }[];
      return rows.map((r) => {
        let addressedTo: string[];
        try {
          addressedTo = addressedToSchema.parse(JSON.parse(r.addressed_to));
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
          runId: r.run_id ?? undefined,
        };
      });
    },
  };
}
