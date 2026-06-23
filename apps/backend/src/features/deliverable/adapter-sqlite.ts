import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import type { DeliverableRow } from "./domain.js";
import type { DeliverablePort } from "./ports.js";

const toRow = (r: typeof schema.deliverable.$inferSelect): DeliverableRow => ({
  deliverableId: r.deliverableId,
  issueId: r.issueId,
  fromStatus: r.fromStatus,
  kind: r.kind,
  fields: JSON.parse(r.fields) as Record<string, string>,
  ref: r.ref,
  runId: r.runId,
  createdAt: r.createdAt,
});

export function sqliteDeliverableAdapter(db: Database): DeliverablePort {
  const d = drizzle(db, { schema, casing: "snake_case" });

  return {
    /** R2: INSERT … ON CONFLICT(run_id, kind) WHERE run_id IS NOT NULL DO NOTHING — atomic idempotency.
     *  Returns { row, replay: true } when the row already exists.
     *
     *  M20: Kept as raw SQL because drizzle's onConflictDoNothing({ target, targetWhere })
     *  does not reliably generate the correct ON CONFLICT ... WHERE clause for partial unique
     *  indexes across all drizzle-orm versions. The raw SQL is well-tested and simpler. */
    insert(input): { row: DeliverableRow; replay: boolean } {
      db.run(
        `INSERT INTO deliverable (deliverable_id, issue_id, from_status, kind, fields, ref, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, kind) WHERE run_id IS NOT NULL DO NOTHING`,
        [
          input.deliverableId,
          input.issueId,
          input.fromStatus,
          input.kind,
          JSON.stringify(input.fields),
          input.ref,
          input.runId,
          input.createdAt,
        ],
      );
      const { changes } = db.query("SELECT changes() AS changes").get() as { changes: number };
      if (changes === 0 && input.runId) {
        const existing = d
          .select()
          .from(schema.deliverable)
          .where(
            and(eq(schema.deliverable.runId, input.runId), eq(schema.deliverable.kind, input.kind)),
          )
          .get();
        if (existing) return { row: toRow(existing), replay: true };
      }
      return {
        row: {
          deliverableId: input.deliverableId,
          issueId: input.issueId,
          fromStatus: input.fromStatus,
          kind: input.kind,
          fields: input.fields,
          ref: input.ref,
          runId: input.runId,
          createdAt: input.createdAt,
        },
        replay: false,
      };
    },

    /** R5: ORDER BY created_at ASC, deliverable_id ASC — ulid tiebreaker for deterministic last-write-wins. */
    listByIssue(issueId: string): DeliverableRow[] {
      const rows = d
        .select()
        .from(schema.deliverable)
        .where(eq(schema.deliverable.issueId, issueId))
        .orderBy(schema.deliverable.createdAt, schema.deliverable.deliverableId)
        .all();
      return rows.map(toRow);
    },

    getByRunAndKind(runId: string, kind: string): DeliverableRow | null {
      const r = d
        .select()
        .from(schema.deliverable)
        .where(and(eq(schema.deliverable.runId, runId), eq(schema.deliverable.kind, kind)))
        .get();
      return r ? toRow(r) : null;
    },
  };
}
