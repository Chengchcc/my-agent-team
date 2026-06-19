/** 交付物 — 某一棒执行器在干完时显式提交的结构化产物。
 *  追加式落库：同 (issueId, kind) 可多行，取 created_at 最大者为最新。 */
export interface DeliverableRow {
  deliverableId: string;
  issueId: string;
  fromStatus: string;
  kind: string;
  fields: Record<string, string>;
  ref: string | null;
  runId: string | null;
  idempotencyKey: string | null;
  createdAt: number;
}
