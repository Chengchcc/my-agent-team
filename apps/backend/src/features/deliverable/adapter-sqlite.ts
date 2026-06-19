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
  idempotency_key: string | null;
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
  idempotencyKey: r.idempotency_key,
  createdAt: r.created_at,
});

export function sqliteDeliverableAdapter(db: Database): DeliverablePort {
  return {
    insert(input): DeliverableRow {
      db.run(
        `INSERT INTO deliverable (deliverable_id, issue_id, from_status, kind, fields, ref, run_id, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.deliverableId,
          input.issueId,
          input.fromStatus,
          input.kind,
          JSON.stringify(input.fields),
          input.ref,
          input.runId,
          input.idempotencyKey,
          input.createdAt,
        ],
      );
      return {
        deliverableId: input.deliverableId,
        issueId: input.issueId,
        fromStatus: input.fromStatus,
        kind: input.kind,
        fields: input.fields,
        ref: input.ref,
        runId: input.runId,
        idempotencyKey: input.idempotencyKey,
        createdAt: input.createdAt,
      };
    },

    listByIssue(issueId: string): DeliverableRow[] {
      const rows = db
        .query("SELECT * FROM deliverable WHERE issue_id = ? ORDER BY created_at ASC")
        .all(issueId) as Raw[];
      return rows.map(toRow);
    },

    getByIdempotencyKey(key: string): DeliverableRow | null {
      const r = db
        .query("SELECT * FROM deliverable WHERE idempotency_key = ?")
        .get(key) as Raw | undefined;
      return r ? toRow(r) : null;
    },
  };
}
