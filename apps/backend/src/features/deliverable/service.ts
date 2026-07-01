import type { DeliverableRow } from "./domain.js";
import type { DeliverablePort } from "./ports.js";

export function createDeliverableService(deps: {
  port: DeliverablePort;
  idGen: () => string;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  return {
    port: deps.port,

    /** 提交一份交付物（追加）。归属 (issueId, fromStatus) 由调用方补全后传入。
     *  幂等由 adapter 的 INSERT … ON CONFLICT(span_id, kind) 保证。
     *  返回 { row, replay } — replay 为 true 表示该 (spanId, kind) 已有交付物。 */
    submit(input: {
      issueId: string;
      fromStatus: string;
      kind: string;
      fields: Record<string, string>;
      ref?: string;
      spanId?: string;
    }): { row: DeliverableRow; replay: boolean } {
      return deps.port.insert({
        deliverableId: deps.idGen(),
        issueId: input.issueId,
        fromStatus: input.fromStatus,
        kind: input.kind,
        fields: input.fields,
        ref: input.ref ?? null,
        spanId: input.spanId ?? null,
        createdAt: now(),
      });
    },

    listByIssue(issueId: string): DeliverableRow[] {
      return deps.port.listByIssue(issueId);
    },
  };
}

export type DeliverableService = ReturnType<typeof createDeliverableService>;
