import type { Database } from "bun:sqlite";
import { and, eq, gt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { z } from "zod";
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

const addressedToSchema = z.array(z.string());

export function sqliteConversationAdapter(db: Database): ConversationPort {
  const d = drizzle(db, { schema });

  return {
    // ─── Conversation ──────────────────────────────

    createConversation(input: CreateConversationInput): ConversationRow {
      d.insert(schema.conversation)
        .values({
          conversationId: input.conversationId,
          triggerMode: input.triggerMode ?? "mention",
          hopCount: 0,
          origin: input.origin ?? "user",
          createdAt: input.createdAt,
        })
        .run();
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
      const row = d
        .select()
        .from(schema.conversation)
        .where(eq(schema.conversation.conversationId, conversationId))
        .get();
      if (!row) return null;
      return {
        conversationId: row.conversationId,
        triggerMode: row.triggerMode,
        hopCount: row.hopCount,
        origin: row.origin,
        createdAt: row.createdAt,
        title: row.title,
      };
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
        .orderBy(schema.conversation.createdAt)
        .all();
      // N+1: members fetched per conversation — kept as-is for behavior equivalence.
      // Performance optimization (join/batch) deferred to a separate PR.
      return convs.map((c) => ({
        conversationId: c.conversationId,
        triggerMode: c.triggerMode,
        hopCount: c.hopCount,
        origin: c.origin,
        createdAt: c.createdAt,
        title: c.title,
        members: d
          .select()
          .from(schema.member)
          .where(eq(schema.member.conversationId, c.conversationId))
          .all()
          .map(
            (m): MemberRow => ({
              memberId: m.memberId,
              conversationId: m.conversationId,
              kind: m.kind as MemberRow["kind"],
              agentId: m.agentId,
              userRef: m.userRef,
              displayName: m.displayName,
              joinedAt: m.joinedAt,
            }),
          ),
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
            conversationId: c.conversationId,
            triggerMode: c.triggerMode,
            hopCount: c.hopCount,
            origin: c.origin,
            createdAt: c.createdAt,
            title: c.title,
            members: d
              .select()
              .from(schema.member)
              .where(eq(schema.member.conversationId, c.conversationId))
              .all()
              .map(
                (m): MemberRow => ({
                  memberId: m.memberId,
                  conversationId: m.conversationId,
                  kind: m.kind as MemberRow["kind"],
                  agentId: m.agentId,
                  userRef: m.userRef,
                  displayName: m.displayName,
                  joinedAt: m.joinedAt,
                }),
              ),
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
        created: rows.length > 0,
      };
    },

    getMembers(conversationId: string): MemberRow[] {
      return d
        .select()
        .from(schema.member)
        .where(eq(schema.member.conversationId, conversationId))
        .orderBy(schema.member.joinedAt)
        .all()
        .map(
          (r): MemberRow => ({
            memberId: r.memberId,
            conversationId: r.conversationId,
            kind: r.kind as MemberRow["kind"],
            agentId: r.agentId,
            userRef: r.userRef,
            displayName: r.displayName,
            joinedAt: r.joinedAt,
          }),
        );
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
          runId: input.runId ?? null,
        })
        .returning({ seq: schema.conversationLedger.seq })
        .get();
      return row!.seq;
    },

    hasLedgerContent(runId: string, content: string): boolean {
      const row = d
        .select({ one: sql`1` })
        .from(schema.conversationLedger)
        .where(
          and(
            eq(schema.conversationLedger.runId, runId),
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
        let addressedTo: string[];
        try {
          addressedTo = addressedToSchema.parse(JSON.parse(r.addressedTo));
        } catch {
          addressedTo = [];
        }
        return {
          seq: r.seq,
          conversationId: r.conversationId,
          senderMemberId: r.senderMemberId,
          addressedTo,
          kind: r.kind as LedgerEntry["kind"],
          content: r.content,
          ts: r.ts,
          runId: r.runId ?? undefined,
        };
      });
    },
  };
}
