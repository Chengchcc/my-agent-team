import type { Database } from "bun:sqlite";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
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

export function sqliteConversationAdapter(db: Database): ConversationPort {
  const d = drizzle(db, { schema, casing: "snake_case" });

  return {
    // ─── Conversation ──────────────────────────────

    createConversation(input: CreateConversationInput): ConversationRow {
      const row = d
        .insert(schema.conversation)
        .values({
          conversationId: input.conversationId,
          triggerMode: input.triggerMode ?? "mention",
          hopCount: 0,
          origin: input.origin ?? "user",
          createdAt: input.createdAt,
        })
        .returning()
        .get();
      return schema.conversationSelectSchema.parse(row);
    },

    getConversation(conversationId: string): ConversationRow | null {
      const row = d
        .select()
        .from(schema.conversation)
        .where(eq(schema.conversation.conversationId, conversationId))
        .get();
      if (!row) return null;
      return schema.conversationSelectSchema.parse(row);
    },

    setConversationTitle(conversationId: string, title: string): void {
      d.update(schema.conversation)
        .set({ title })
        .where(eq(schema.conversation.conversationId, conversationId))
        .run();
    },

    updateHopCount(conversationId: string, count: number): void {
      d.update(schema.conversation)
        .set({ hopCount: count })
        .where(eq(schema.conversation.conversationId, conversationId))
        .run();
    },

    listConversations(): ConversationWithMembers[] {
      const convs = d
        .select()
        .from(schema.conversation)
        .where(eq(schema.conversation.origin, "user"))
        .orderBy(desc(schema.conversation.createdAt))
        .all();
      // N+1: members fetched per conversation — kept as-is for behavior equivalence.
      // Performance optimization (join/batch) deferred to a separate PR.
      return convs.map((c) => ({
        ...schema.conversationSelectSchema.parse(c),
        members: d
          .select()
          .from(schema.member)
          .where(eq(schema.member.conversationId, c.conversationId))
          .all()
          .map((m) => schema.memberSelectSchema.parse(m) as MemberRow),
      }));
    },

    deleteConversation(conversationId: string): boolean {
      // M20: Threads table was dropped in M14 (backend_v17_drop_threads_legacy).
      // The old LIKE-prefix DELETE FROM threads is dead code — removed.
      const rows = d
        .delete(schema.conversation)
        .where(eq(schema.conversation.conversationId, conversationId))
        .returning()
        .all();
      return rows.length > 0;
    },

    listConversationsByAgent(agentId: string): ConversationWithMembers[] {
      const memberRows = d
        .selectDistinct({ conversationId: schema.member.conversationId })
        .from(schema.member)
        .where(eq(schema.member.agentId, agentId))
        .all();
      // N+1: conversations and members fetched per conversation — kept as-is.
      return memberRows
        .map((mr) => {
          const c = d
            .select()
            .from(schema.conversation)
            .where(eq(schema.conversation.conversationId, mr.conversationId))
            .get();
          if (!c) return null;
          return {
            ...schema.conversationSelectSchema.parse(c),
            members: d
              .select()
              .from(schema.member)
              .where(eq(schema.member.conversationId, c.conversationId))
              .all()
              .map((m) => schema.memberSelectSchema.parse(m) as MemberRow),
          };
        })
        .filter(Boolean) as ConversationWithMembers[];
    },

    // ─── Member ────────────────────────────────────

    addMember(input: CreateMemberInput): { member: MemberRow; created: boolean } {
      const rows = d
        .insert(schema.member)
        .values({
          memberId: input.memberId,
          conversationId: input.conversationId,
          kind: input.kind,
          agentId: input.agentId ?? null,
          userRef: input.userRef ?? null,
          displayName: input.displayName ?? null,
          joinedAt: input.joinedAt,
        })
        .onConflictDoNothing()
        .returning()
        .all();
      const created = rows.length > 0;
      const member: MemberRow = created
        ? (schema.memberSelectSchema.parse(rows[0]) as MemberRow)
        : ({
            memberId: input.memberId,
            conversationId: input.conversationId,
            kind: input.kind,
            agentId: input.agentId ?? null,
            userRef: input.userRef ?? null,
            displayName: input.displayName ?? null,
            joinedAt: input.joinedAt,
          } as MemberRow);
      return { member, created };
    },

    getMembers(conversationId: string): MemberRow[] {
      return d
        .select()
        .from(schema.member)
        .where(eq(schema.member.conversationId, conversationId))
        .orderBy(schema.member.joinedAt)
        .all()
        .map((r) => schema.memberSelectSchema.parse(r) as MemberRow);
    },

    getAgentMembers(conversationId: string): MemberRow[] {
      return this.getMembers(conversationId).filter((m) => m.kind === "agent");
    },

    removeMember(conversationId: string, memberId: string): boolean {
      const rows = d
        .delete(schema.member)
        .where(
          and(
            eq(schema.member.conversationId, conversationId),
            eq(schema.member.memberId, memberId),
          ),
        )
        .returning()
        .all();
      return rows.length > 0;
    },

    // ─── Ledger ────────────────────────────────────

    appendLedgerEntry(input: AppendLedgerInput): number {
      const row = d
        .insert(schema.conversationLedger)
        .values({
          conversationId: input.conversationId,
          senderMemberId: input.senderMemberId,
          addressedTo: JSON.stringify(input.addressedTo ?? []),
          kind: input.kind,
          content: input.content,
          ts: input.ts,
          spanId: input.spanId ?? null,
        })
        .returning({ seq: schema.conversationLedger.seq })
        .get();
      return row!.seq;
    },

    hasLedgerContent(spanId: string, content: string): boolean {
      const row = d
        .select({ one: sql`1` })
        .from(schema.conversationLedger)
        .where(
          and(
            eq(schema.conversationLedger.spanId, spanId),
            eq(schema.conversationLedger.content, content),
          ),
        )
        .limit(1)
        .get();
      return row !== undefined;
    },

    getLedgerEntries(conversationId: string, opts?: { sinceSeq?: number }): LedgerEntry[] {
      const since = opts?.sinceSeq ?? 0;
      const rows = d
        .select()
        .from(schema.conversationLedger)
        .where(
          and(
            eq(schema.conversationLedger.conversationId, conversationId),
            gt(schema.conversationLedger.seq, since),
          ),
        )
        .orderBy(schema.conversationLedger.seq)
        .all();
      return rows.map((r) => {
        const result = schema.conversationLedgerSelectSchema.safeParse(r);
        if (result.success) return result.data as LedgerEntry;
        // Defensive fallback for rows with malformed JSON in addressedTo/content columns.
        return {
          seq: r.seq,
          conversationId: r.conversationId,
          senderMemberId: r.senderMemberId,
          addressedTo: [] as string[],
          kind: r.kind as LedgerEntry["kind"],
          content: r.content,
          ts: r.ts,
          spanId: r.spanId,
        } as LedgerEntry;
      });
    },
  };
}
