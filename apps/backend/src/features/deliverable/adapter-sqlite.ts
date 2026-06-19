import type { Database } from "bun:sqlite";
import type { DeliverableRow } from "./domain.js";
import type { DeliverablePort } from "./ports.js";

type Raw = {
  deliverable_id: string;
  issue_id: string;
  from_status: string;
  kind: string;
  fields: string;
  ref: string | null;
  run_id: string | null;
  created_at: number;
};

const toRow = (r: Raw): DeliverableRow => ({
  deliverableId: r.deliverable_id,
  issueId: r.issue_id,
  fromStatus: r.from_status,
  kind: r.kind,
  fields: JSON.parse(r.fields) as Record<string, string>,
  ref: r.ref,
  runId: r.run_id,
  createdAt: r.created_at,
});

export function sqliteDeliverableAdapter(db: Database): DeliverablePort {
  return {
    /** R2: INSERT … ON CONFLICT(run_id, kind) DO NOTHING — atomic idempotency.
     *  Returns { row, replay: true } when the row already exists. */
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
        const existing = db
          .query("SELECT * FROM deliverable WHERE run_id = ? AND kind = ?")
          .get(input.runId, input.kind) as Raw | undefined;
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
      const rows = db
        .query(
          "SELECT * FROM deliverable WHERE issue_id = ? ORDER BY created_at ASC, deliverable_id ASC",
        )
        .all(issueId) as Raw[];
      return rows.map(toRow);
    },

    getByRunAndKind(runId: string, kind: string): DeliverableRow | null {
      const r = db
        .query("SELECT * FROM deliverable WHERE run_id = ? AND kind = ?")
        .get(runId, kind) as Raw | undefined;
      return r ? toRow(r) : null;
    },
  };
}
