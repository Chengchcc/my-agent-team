import type { DeliverableRow } from "./domain.js";

export interface DeliverablePort {
  insert(input: {
    deliverableId: string;
    issueId: string;
    fromStatus: string;
    kind: string;
    fields: Record<string, string>;
    ref: string | null;
    runId: string | null;
    idempotencyKey: string | null;
    createdAt: number;
  }): DeliverableRow;

  /** ORDER BY created_at ASC — 消费端按 kind 聚合时后写覆盖（取最新）。 */
  listByIssue(issueId: string): DeliverableRow[];

  /** 幂等查重。idempotencyKey 可空（未传则不走幂等）。 */
  getByIdempotencyKey(key: string): DeliverableRow | null;
}
