import type * as schema from "../../infra/db/schema.js";
import type { AgentRun, BranchInput, PendingActionRecord } from "./domain.js";
import type { BackendRunOutcome } from "./protocol/index.js";

export function parseModelRef(json: string): AgentRun["modelRef"] {
  return JSON.parse(json) as AgentRun["modelRef"];
}

export function parseRun(row: typeof schema.agentRun.$inferSelect): AgentRun {
  return {
    runId: row.runId,
    branchId: row.branchId,
    conversationId: row.conversationId,
    agentId: row.agentId,
    modelRef: parseModelRef(row.modelRef),
    status: row.status as AgentRun["status"],
    idempotencyKey: row.idempotencyKey,
    terminalResult: row.terminalResult
      ? (JSON.parse(row.terminalResult) as BackendRunOutcome)
      : null,
    configRevision: row.configRevision,
    workspace:
      row.workspaceRoot && row.workspaceAccess
        ? { root: row.workspaceRoot, access: row.workspaceAccess as "read_only" | "read_write" }
        : null,
    productTools: row.productTools
      ? (JSON.parse(row.productTools) as AgentRun["productTools"])
      : null,
    systemPrompt: row.systemPrompt,
    skillRoots: row.skillRoots ? (JSON.parse(row.skillRoots) as string[]) : null,
    permissionMode: row.permissionMode,
    toolPolicy: row.toolPolicy ? (JSON.parse(row.toolPolicy) as AgentRun["toolPolicy"]) : null,
    todoSnapshot: row.todoSnapshot,
    nativeSessionRef: row.nativeSessionRef,
    authorization: row.authorization ?? null,
    risk: row.risk ? (JSON.parse(row.risk) as AgentRun["risk"]) : null,
    parentRunId: row.parentRunId ?? null,
    requirementId: row.requirementId ?? null,
    createdAt: row.createdAt,
    terminalAt: row.terminalAt,
    resultNotifiedAt: row.resultNotifiedAt ?? null,
  };
}

export function parseInput(row: typeof schema.branchInputQueue.$inferSelect): BranchInput {
  return {
    inputId: row.inputId,
    seq: row.seq,
    branchId: row.branchId,
    mode: row.mode as BranchInput["mode"],
    message: JSON.parse(row.message) as BranchInput["message"],
    status: row.status as BranchInput["status"],
    deliveryIdempotencyKey: row.deliveryIdempotencyKey,
    inputIdempotencyKey: row.inputIdempotencyKey,
    runId: row.runId,
    configSnapshot: {
      modelRef: row.modelRef
        ? (JSON.parse(row.modelRef) as { backendKind: string; modelId: string })
        : { backendKind: "oma", modelId: "" },
      configRevision: row.configRevision ?? 0,
      workspace:
        row.workspaceRoot && row.workspaceAccess
          ? { root: row.workspaceRoot, access: row.workspaceAccess as "read_only" | "read_write" }
          : null,
      systemPrompt: row.systemPrompt,
      skillRoots: row.skillRoots ? (JSON.parse(row.skillRoots) as string[]) : null,
      permissionMode: row.permissionMode,
      toolPolicy: row.toolPolicy ? (JSON.parse(row.toolPolicy) as AgentRun["toolPolicy"]) : null,
      authorization: row.authorization ?? null,
      parentRunId: row.parentRunId ?? null,
    },
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
  };
}

export function parsePendingAction(
  row: typeof schema.pendingAction.$inferSelect,
): PendingActionRecord {
  return {
    actionId: row.actionId,
    runId: row.runId,
    kind: row.kind,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    status: row.status as PendingActionRecord["status"],
    response: row.response ? JSON.parse(row.response) : null,
    responseIdempotencyKey: row.responseIdempotencyKey,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    ...(row.owner !== null ? { owner: row.owner } : {}),
    answeredBy: row.answeredBy ?? null,
    escalatedAt: row.escalatedAt ?? null,
    ...(row.evidence !== null ? { evidence: JSON.parse(row.evidence) as string[] } : {}),
  };
}
