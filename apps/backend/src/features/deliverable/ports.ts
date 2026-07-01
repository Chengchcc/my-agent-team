import type { DeliverableRow } from "./domain.js";

export interface DeliverablePort {
  /** INSERT … ON CONFLICT(span_id, kind) DO NOTHING.
   *  Returns the row + whether it was a replay (pre-existing). */
  insert(input: {
    deliverableId: string;
    issueId: string;
    fromStatus: string;
    kind: string;
    fields: Record<string, string>;
    ref: string | null;
    spanId: string | null;
    createdAt: number;
  }): { row: DeliverableRow; replay: boolean };

  /** ORDER BY created_at ASC, deliverable_id ASC — 消费端按 kind 聚合时后写覆盖（取最新）。
   *  deliverable_id 兜底打破同毫秒平局。 */
  listByIssue(issueId: string): DeliverableRow[];

  /** 幂等查重：同一 run 同一 kind 是否已有交付物。 */
  getByRunAndKind(spanId: string, kind: string): DeliverableRow | null;
}
