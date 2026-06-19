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

    /** 提交一份交付物（追加）。归属 (issueId, fromStatus) 由调用方补全后传入。 */
    submit(input: {
      issueId: string;
      fromStatus: string;
      kind: string;
      fields: Record<string, string>;
      ref?: string;
      runId?: string;
      idempotencyKey?: string;
    }): DeliverableRow {
      return deps.port.insert({
        deliverableId: deps.idGen(),
        issueId: input.issueId,
        fromStatus: input.fromStatus,
        kind: input.kind,
        fields: input.fields,
        ref: input.ref ?? null,
        runId: input.runId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        createdAt: now(),
      });
    },

    listByIssue(issueId: string): DeliverableRow[] {
      return deps.port.listByIssue(issueId);
    },
  };
}

export type DeliverableService = ReturnType<typeof createDeliverableService>;
