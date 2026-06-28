import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import { deliverableSelectSchema } from "../../infra/db/schema.js";
import type { DeliverableRow } from "./domain.js";
import type { DeliverablePort } from "./ports.js";

export function sqliteDeliverableAdapter(db: Database): DeliverablePort {
  const d = drizzle(db, { schema, casing: "snake_case" });

  return {
    /** R2: INSERT … ON CONFLICT(span_id, kind) WHERE span_id IS NOT NULL DO NOTHING — atomic idempotency.
     *  Returns { row, replay: true } when the row already exists.
     *
     *  M20: Kept as raw SQL because drizzle's onConflictDoNothing({ target, targetWhere })
     *  does not reliably generate the correct ON CONFLICT ... WHERE clause for partial unique
     *  indexes across all drizzle-orm versions. The raw SQL is well-tested and simpler. */
    insert(input): { row: DeliverableRow; replay: boolean } {
      db.run(
        `INSERT INTO deliverable (deliverable_id, issue_id, from_status, kind, fields, ref, span_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(span_id, kind) WHERE span_id IS NOT NULL DO NOTHING`,
        [
          input.deliverableId,
          input.issueId,
          input.fromStatus,
          input.kind,
          JSON.stringify(input.fields),
          input.ref,
          input.spanId,
          input.createdAt,
        ],
      );
      const { changes } = db.query("SELECT changes() AS changes").get() as { changes: number };
      if (changes === 0 && input.spanId) {
        const existing = d
          .select()
          .from(schema.deliverable)
          .where(
            and(
              eq(schema.deliverable.spanId, input.spanId),
              eq(schema.deliverable.kind, input.kind),
            ),
          )
          .get();
        if (existing) return { row: deliverableSelectSchema.parse(existing), replay: true };
      }
      return {
        row: deliverableSelectSchema.parse({
          deliverableId: input.deliverableId,
          issueId: input.issueId,
          fromStatus: input.fromStatus,
          kind: input.kind,
          fields: JSON.stringify(input.fields),
          ref: input.ref,
          spanId: input.spanId,
          createdAt: input.createdAt,
        }),
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
      return rows.map((r) => deliverableSelectSchema.parse(r));
    },

    getByRunAndKind(spanId: string, kind: string): DeliverableRow | null {
      const r = d
        .select()
        .from(schema.deliverable)
        .where(and(eq(schema.deliverable.spanId, spanId), eq(schema.deliverable.kind, kind)))
        .get();
      return r ? deliverableSelectSchema.parse(r) : null;
    },
  };
}
