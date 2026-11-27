import type { Database } from "bun:sqlite";
import { needleSegments } from "@chengchenccc/embedding";
import { deserializeLedgerContent, extractText } from "@chengchenccc/message";
import { and, desc, eq, gt, inArray, isNotNull, like, notInArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import { ConflictError } from "../../infra/domain-errors.js";
import { senderLabelOf } from "./ledger-codec.js";
import type {
  AppendLedgerInput,
  ConversationPort,
  ConversationRow,
  ConversationSummary,
  CreateConversationInput,
  LedgerEntry,
} from "./ports.js";

export function sqliteConversationAdapter(db: Database): ConversationPort {
  const d = drizzle(db, { schema, casing: "snake_case" });
  /** Last ledger entry timestamp for a conversation, or null if it has no messages. */
  const lastLedgerTs = (conversationId: string): number | null => {
    const row = d
      .select({ max: sql<number | null>`MAX(${schema.conversationLedger.ts})` })
      .from(schema.conversationLedger)
      .where(eq(schema.conversationLedger.conversationId, conversationId))
      .get();
    return row?.max ?? null;
  };
  /** Max ledger seq (undone excluded) — the unread anchor for the web list. */
  const lastSeq = (conversationId: string): number | null => {
    const row = d
      .select({ max: sql<number | null>`MAX(${schema.conversationLedger.seq})` })
      .from(schema.conversationLedger)
      .where(
        and(
          eq(schema.conversationLedger.conversationId, conversationId),
          eq(schema.conversationLedger.undone, 0),
        ),
      )
      .get();
    return row?.max ?? null;
  };
  /** ≤120-char text preview of the conversation's last message. */
  const lastMessagePreview = (conversationId: string): string | null => {
    const row = d
      .select({ content: schema.conversationLedger.content })
      .from(schema.conversationLedger)
      .where(eq(schema.conversationLedger.conversationId, conversationId))
      .orderBy(desc(schema.conversationLedger.ts))
      .limit(1)
      .get();
    if (!row) return null;
    const rev = deserializeLedgerContent(row.content);
    const text = extractText("raw" in rev ? {} : rev).trim();
    if (!text) return null;
    return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  };

  return {
    // ─── Conversation ──────────────────────────────

    createConversation(input: CreateConversationInput): ConversationRow {
      const row = d
        .insert(schema.conversation)
        .values({
          conversationId: input.conversationId,
          agentId: input.agentId ?? null,
          hopCount: 0,
          origin: input.origin ?? "user",
          createdAt: input.createdAt,
          forkSource: input.forkSource ?? null,
          forkFromSeq: input.forkFromSeq ?? null,
          projectId: input.projectId ?? null,
          parentConversationId: input.parentConversationId ?? null,
        })
        .returning()
        .get();
      const parsed = schema.conversationSelectSchema.parse(row);
      return parsed;
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

    listChildConversations(parentConversationId: string): ConversationRow[] {
      return d
        .select()
        .from(schema.conversation)
        .where(eq(schema.conversation.parentConversationId, parentConversationId))
        .orderBy(schema.conversation.createdAt)
        .all()
        .map((row) => schema.conversationSelectSchema.parse(row));
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

    hasProjectBinding(projectId: string): boolean {
      const row = d
        .select({ one: schema.conversation.conversationId })
        .from(schema.conversation)
        .where(eq(schema.conversation.projectId, projectId))
        .limit(1)
        .get();
      return row !== undefined;
    },

    listConversations(): ConversationSummary[] {
      const convs = d
        .select()
        .from(schema.conversation)
        // ADR 0074 S0: a dispatch room (origin "dispatch") is listed too — the
        // nav shows it NESTED under the room that dispatched it (the web groups
        // by parentConversationId). "Only roots" (ADR 0070 D3) hid the team.
        .where(inArray(schema.conversation.origin, ["user", "fork", "dispatch"]))
        .orderBy(desc(schema.conversation.createdAt))
        .all();
      return convs.map((c) => ({
        ...schema.conversationSelectSchema.parse(c),
        lastActivityAt: lastLedgerTs(c.conversationId),
        lastMessagePreview: lastMessagePreview(c.conversationId),
        lastSeq: lastSeq(c.conversationId),
      }));
    },

    async deleteConversation(conversationId: string): Promise<boolean> {
      // Collect the full subtree (root + all ADR 0070 dispatched descendants)
      // and check active runs across EVERY room inside ONE IMMEDIATE transaction
      // so a child room with an active run can never leave siblings half-deleted.
      return db
        .transaction(() => {
          const exists = d
            .select({ id: schema.conversation.conversationId })
            .from(schema.conversation)
            .where(eq(schema.conversation.conversationId, conversationId))
            .get();
          if (!exists) return false;

          // BFS from root to gather descendants; delete in reverse order (leaves first).
          const subtree: string[] = [conversationId];
          for (let i = 0; i < subtree.length; i++) {
            const parentId = subtree[i]!;
            const kids = d
              .select({ id: schema.conversation.conversationId })
              .from(schema.conversation)
              .where(eq(schema.conversation.parentConversationId, parentId))
              .all();
            for (const kid of kids) subtree.push(kid.id);
          }

          // Guard: reject if ANY room in the subtree has an active run.
          for (let i = 0; i < subtree.length; i += 500) {
            const chunk = subtree.slice(i, i + 500);
            const active = d
              .select({ runId: schema.agentRun.runId })
              .from(schema.agentRun)
              .where(
                and(
                  inArray(schema.agentRun.conversationId, chunk),
                  inArray(schema.agentRun.status, ["running", "waiting", "commit_failed"]),
                ),
              )
              .get();
            if (active) {
              throw new ConflictError("Conversation has an active run; stop it before deleting.");
            }
          }

          // Delete leaves first so parent_conversation_id FK never blocks.
          for (let i = subtree.length - 1; i >= 0; i--) {
            const cid = subtree[i]!;
            const trees = d
              .select({ treeId: schema.agentContextTree.treeId })
              .from(schema.agentContextTree)
              .where(eq(schema.agentContextTree.conversationId, cid))
              .all();
            for (const { treeId } of trees) {
              const children = d
                .selectDistinct({ parentId: schema.agentContextEntry.parentId })
                .from(schema.agentContextEntry)
                .where(
                  and(
                    eq(schema.agentContextEntry.treeId, treeId),
                    isNotNull(schema.agentContextEntry.parentId),
                  ),
                );
              for (;;) {
                d.delete(schema.agentContextEntry)
                  .where(
                    and(
                      eq(schema.agentContextEntry.treeId, treeId),
                      notInArray(schema.agentContextEntry.entryId, children),
                    ),
                  )
                  .run();
                const left = d
                  .select({ id: schema.agentContextEntry.entryId })
                  .from(schema.agentContextEntry)
                  .where(eq(schema.agentContextEntry.treeId, treeId))
                  .limit(1)
                  .get();
                if (!left) break;
              }
            }
            d.delete(schema.conversationRequirement)
              .where(eq(schema.conversationRequirement.conversationId, cid))
              .run();
            d.delete(schema.conversation).where(eq(schema.conversation.conversationId, cid)).run();
          }
          return true;
        })
        .immediate();
    },

    listConversationsByAgent(agentId: string): ConversationSummary[] {
      const convs = d
        .select()
        .from(schema.conversation)
        .where(eq(schema.conversation.agentId, agentId))
        .orderBy(desc(schema.conversation.createdAt))
        .all();
      return convs.map((c) => ({
        ...schema.conversationSelectSchema.parse(c),
        lastActivityAt: lastLedgerTs(c.conversationId),
        lastMessagePreview: lastMessagePreview(c.conversationId),
        lastSeq: lastSeq(c.conversationId),
      }));
    },
    getLastMessagePreview(conversationId: string): string | null {
      return lastMessagePreview(conversationId);
    },
    getLastSeq(conversationId: string): number | null {
      return lastSeq(conversationId);
    },
    setSaved(seq: number, saved: boolean, conversationId?: string): boolean {
      const cond = conversationId
        ? and(
            eq(schema.conversationLedger.seq, seq),
            eq(schema.conversationLedger.conversationId, conversationId),
          )
        : eq(schema.conversationLedger.seq, seq);
      const rows = d
        .update(schema.conversationLedger)
        .set({ saved: saved ? 1 : 0 })
        .where(cond)
        .returning({ seq: schema.conversationLedger.seq })
        .all();
      return rows.length > 0;
    },
    runInTransaction<T>(fn: () => T): T {
      return db.transaction(fn).immediate();
    },
    listSaved(): Array<{
      seq: number;
      conversationId: string;
      conversationTitle: string | null;
      text: string | null;
      ts: number;
    }> {
      const rows = d
        .select({
          seq: schema.conversationLedger.seq,
          conversationId: schema.conversationLedger.conversationId,
          conversationTitle: schema.conversation.title,
          content: schema.conversationLedger.content,
          ts: schema.conversationLedger.ts,
        })
        .from(schema.conversationLedger)
        .leftJoin(
          schema.conversation,
          eq(schema.conversationLedger.conversationId, schema.conversation.conversationId),
        )
        .where(eq(schema.conversationLedger.saved, 1))
        .orderBy(desc(schema.conversationLedger.seq))
        .limit(200)
        .all();
      return rows.map((r) => ({
        seq: r.seq,
        conversationId: r.conversationId,
        conversationTitle: r.conversationTitle,
        text: (() => {
          try {
            return extractText(JSON.parse(r.content) as { text?: string }) ?? null;
          } catch {
            return null;
          }
        })(),
        ts: r.ts,
      }));
    },
    getLastActivityAt(conversationId: string): number | null {
      return lastLedgerTs(conversationId);
    },
    // ─── Ledger ────────────────────────────────────

    appendLedgerEntry(input: AppendLedgerInput): number {
      const row = d
        .insert(schema.conversationLedger)
        .values({
          conversationId: input.conversationId,
          kind: input.kind,
          content: input.content,
          ts: input.ts,
        })
        .returning({ seq: schema.conversationLedger.seq })
        .get();
      return row!.seq;
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
        // Defensive fallback for rows with malformed JSON in the content column.
        return {
          seq: r.seq,
          conversationId: r.conversationId,
          kind: r.kind as LedgerEntry["kind"],
          content: r.content,
          ts: r.ts,
          agentRunId: r.agentRunId,
          messageIndex: r.messageIndex,
          undone: r.undone === 1,
        } as LedgerEntry;
      });
    },

    getLedgerEntry(conversationId: string, seq: number): LedgerEntry | null {
      const row = d
        .select()
        .from(schema.conversationLedger)
        .where(
          and(
            eq(schema.conversationLedger.conversationId, conversationId),
            eq(schema.conversationLedger.seq, seq),
          ),
        )
        .get();
      if (!row) return null;
      const result = schema.conversationLedgerSelectSchema.safeParse(row);
      if (result.success) return result.data as LedgerEntry;
      return {
        seq: row.seq,
        conversationId: row.conversationId,
        kind: row.kind as LedgerEntry["kind"],
        content: row.content,
        ts: row.ts,
        agentRunId: row.agentRunId,
        messageIndex: row.messageIndex,
        undone: row.undone === 1,
      } as LedgerEntry;
    },
    searchLedger(keyword: string, limit = 20, scope?: { conversationId?: string }) {
      // Every needle must appear, not the query verbatim: the old
      // LIKE %query% missed any row where the words sat apart, so searching
      // "husky pathspec" returned nothing even with both present.
      // Needles come from the embedding package's segmenter (maximal CJK runs
      // and ASCII terms) — the same segmentation the memory recall uses, and it
      // only ever emits letters/digits/_/-, so a needle cannot smuggle a LIKE
      // wildcard. FTS5 would add token-boundary matching, but at ~1.9k rows a
      // two-needle scan costs ~7ms: the index would buy a migration, triggers
      // and snapshot bookkeeping for nothing. Revisit at ~10x that corpus.
      const needles = needleSegments(keyword);
      const clauses = (needles.length > 0 ? needles : [keyword]).map((needle) =>
        like(schema.conversationLedger.content, `%${needle}%`),
      );
      const rows = d
        .select({
          conversationId: schema.conversationLedger.conversationId,
          seq: schema.conversationLedger.seq,
          ts: schema.conversationLedger.ts,
          content: schema.conversationLedger.content,
          conversationTitle: schema.conversation.title,
        })
        .from(schema.conversationLedger)
        .leftJoin(
          schema.conversation,
          eq(schema.conversationLedger.conversationId, schema.conversation.conversationId),
        )
        .where(
          scope?.conversationId
            ? and(...clauses, eq(schema.conversationLedger.conversationId, scope.conversationId))
            : and(...clauses),
        )
        .orderBy(desc(schema.conversationLedger.ts))
        .limit(limit)
        .all();
      return rows.map((r) => ({
        conversationId: r.conversationId,
        seq: r.seq,
        snippet: r.content.slice(0, 200),
        ts: r.ts,
        senderName: senderLabelOf(r.content),
        conversationTitle: r.conversationTitle ?? null,
      }));
    },
    markLedgerEntryUndone(conversationId: string, seq: number): void {
      d.update(schema.conversationLedger)
        .set({ undone: 1 })
        .where(
          and(
            eq(schema.conversationLedger.conversationId, conversationId),
            eq(schema.conversationLedger.seq, seq),
          ),
        )
        .run();
    },
    getForkSource(conversationId: string): { source: string; fromSeq: number } | null {
      const row = d
        .select({
          forkSource: schema.conversation.forkSource,
          forkFromSeq: schema.conversation.forkFromSeq,
        })
        .from(schema.conversation)
        .where(eq(schema.conversation.conversationId, conversationId))
        .get();
      if (!row?.forkSource || row.forkFromSeq === null) return null;
      return { source: row.forkSource, fromSeq: row.forkFromSeq };
    },
  };
}
