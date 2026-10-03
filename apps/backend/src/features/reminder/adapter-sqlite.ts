import type { Database } from "bun:sqlite";
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import type { CreateReminderInput, ReminderRow } from "./domain.js";
import type { ReminderPort } from "./ports.js";

export function sqliteReminderAdapter(db: Database): ReminderPort {
  const d = drizzle(db, { schema, casing: "snake_case" });

  const rowOf = (r: typeof schema.reminder.$inferSelect): ReminderRow => ({
    id: r.id,
    conversationId: r.conversationId,
    createdBy: r.createdBy,
    text: r.text,
    fireAt: r.fireAt,
    firedAt: r.firedAt,
    createdAt: r.createdAt,
  });

  return {
    create(input: CreateReminderInput & { id: string; createdAt: number }): ReminderRow {
      const row = d
        .insert(schema.reminder)
        .values({
          id: input.id,
          conversationId: input.conversationId,
          createdBy: input.createdBy,
          text: input.text,
          fireAt: input.fireAt,
          firedAt: null,
          createdAt: input.createdAt,
        })
        .returning()
        .get();
      return rowOf(row);
    },
    due(now: number, limit = 20): ReminderRow[] {
      return d
        .select()
        .from(schema.reminder)
        .where(and(isNull(schema.reminder.firedAt), lte(schema.reminder.fireAt, now)))
        .orderBy(asc(schema.reminder.fireAt))
        .limit(limit)
        .all()
        .map(rowOf);
    },
    markFired(id: string, now: number): boolean {
      const rows = d
        .update(schema.reminder)
        .set({ firedAt: now })
        .where(and(eq(schema.reminder.id, id), isNull(schema.reminder.firedAt)))
        .returning({ id: schema.reminder.id })
        .all();
      return rows.length > 0;
    },
    listPending(conversationId: string): Array<ReminderRow & { conversationTitle: string | null }> {
      return d
        .select({
          id: schema.reminder.id,
          conversationId: schema.reminder.conversationId,
          createdBy: schema.reminder.createdBy,
          text: schema.reminder.text,
          fireAt: schema.reminder.fireAt,
          firedAt: schema.reminder.firedAt,
          createdAt: schema.reminder.createdAt,
          conversationTitle: schema.conversation.title,
        })
        .from(schema.reminder)
        .leftJoin(
          schema.conversation,
          eq(schema.reminder.conversationId, schema.conversation.conversationId),
        )
        .where(
          and(eq(schema.reminder.conversationId, conversationId), isNull(schema.reminder.firedAt)),
        )
        .orderBy(asc(schema.reminder.fireAt))
        .all();
    },
    snooze(id: string, fireAt: number): boolean {
      const rows = d
        .update(schema.reminder)
        .set({ fireAt })
        .where(and(eq(schema.reminder.id, id), isNull(schema.reminder.firedAt)))
        .returning({ id: schema.reminder.id })
        .all();
      return rows.length > 0;
    },
    listPendingRow(id: string): ReminderRow | null {
      const row = d
        .select()
        .from(schema.reminder)
        .where(and(eq(schema.reminder.id, id), isNull(schema.reminder.firedAt)))
        .get();
      return row ? rowOf(row) : null;
    },
    listAllPending(limit = 50): Array<ReminderRow & { conversationTitle: string | null }> {
      return d
        .select({
          id: schema.reminder.id,
          conversationId: schema.reminder.conversationId,
          createdBy: schema.reminder.createdBy,
          text: schema.reminder.text,
          fireAt: schema.reminder.fireAt,
          firedAt: schema.reminder.firedAt,
          createdAt: schema.reminder.createdAt,
          conversationTitle: schema.conversation.title,
        })
        .from(schema.reminder)
        .leftJoin(
          schema.conversation,
          eq(schema.reminder.conversationId, schema.conversation.conversationId),
        )
        .where(isNull(schema.reminder.firedAt))
        .orderBy(asc(schema.reminder.fireAt))
        .limit(limit)
        .all();
    },
    cancel(id: string): boolean {
      const rows = d
        .delete(schema.reminder)
        .where(and(eq(schema.reminder.id, id), isNull(schema.reminder.firedAt)))
        .returning({ id: schema.reminder.id })
        .all();
      return rows.length > 0;
    },
  };
}
