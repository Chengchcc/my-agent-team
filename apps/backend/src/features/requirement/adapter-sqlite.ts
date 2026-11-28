import type { Database } from "bun:sqlite";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import type {
  RequirementPatch,
  RequirementRequestFact,
  RequirementRow,
  RequirementRunFact,
  RequirementWorkflowFact,
} from "./domain.js";

export interface RequirementPort {
  create(row: RequirementRow): RequirementRow;
  get(id: string): RequirementRow | null;
  update(id: string, patch: RequirementPatch, now: number): RequirementRow | null;
  /** Newest first. */
  list(includeClosed: boolean): RequirementRow[];
  listOpenByConversation(conversationId: string, limit: number): RequirementRow[];
  runsOf(id: string): RequirementRunFact[];
  requestsOf(id: string): RequirementRequestFact[];
  workflowExecutionsOf?(id: string): RequirementWorkflowFact[];
}

/** Verification verdict sits inside agent_run.terminal_result (JSON); reads
 *  tolerate every shape because old rows predate the column. */
function verificationOf(terminalResult: string | null): string | null {
  if (terminalResult === null) return null;
  try {
    const parsed: unknown = JSON.parse(terminalResult);
    if (typeof parsed !== "object" || parsed === null) return null;
    const v = (parsed as { verification?: { verdict?: unknown } }).verification?.verdict;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export function sqliteRequirementAdapter(db: Database): RequirementPort {
  const d = drizzle(db, { schema, casing: "snake_case" });
  const toRow = (r: typeof schema.requirement.$inferSelect): RequirementRow => ({
    requirementId: r.requirementId,
    acceptedEvidence: r.acceptedEvidence ? (JSON.parse(r.acceptedEvidence) as string[]) : null,
    acceptedAt: r.acceptedAt ?? null,
    title: r.title,
    goal: r.goal,
    background: r.background ?? null,
    constraints: r.constraints ?? null,
    expectedDeliverables: r.expectedDeliverables ?? null,
    acceptanceCriteria: r.acceptanceCriteria ?? null,
    status: r.status === "done" || r.status === "cancelled" ? r.status : "open",
    projectId: r.projectId ?? null,
    originConversationId: r.originConversationId ?? null,
    originSeq: r.originSeq ?? null,
    createdByAgentId: r.createdByAgentId ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
  return {
    create(row) {
      const inserted = d
        .insert(schema.requirement)
        .values({
          requirementId: row.requirementId,
          title: row.title,
          goal: row.goal,
          background: row.background,
          constraints: row.constraints,
          expectedDeliverables: row.expectedDeliverables,
          acceptanceCriteria: row.acceptanceCriteria,
          status: row.status,
          projectId: row.projectId,
          originConversationId: row.originConversationId,
          originSeq: row.originSeq,
          createdByAgentId: row.createdByAgentId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })
        .returning()
        .get();
      return toRow(inserted);
    },
    get(id) {
      const row = d
        .select()
        .from(schema.requirement)
        .where(eq(schema.requirement.requirementId, id))
        .get();
      return row ? toRow(row) : null;
    },
    update(id, patch, now) {
      const { acceptedEvidence, ...rest } = patch;
      const updated = d
        .update(schema.requirement)
        .set({
          ...rest,
          ...(acceptedEvidence !== undefined
            ? {
                acceptedEvidence:
                  acceptedEvidence === null ? null : JSON.stringify(acceptedEvidence),
              }
            : {}),
          updatedAt: now,
        })
        .where(eq(schema.requirement.requirementId, id))
        .returning()
        .get();
      return updated ? toRow(updated) : null;
    },
    list(includeClosed) {
      const rows = includeClosed
        ? d.select().from(schema.requirement).orderBy(desc(schema.requirement.updatedAt)).all()
        : d
            .select()
            .from(schema.requirement)
            .where(eq(schema.requirement.status, "open"))
            .orderBy(desc(schema.requirement.updatedAt))
            .all();
      return rows.map(toRow);
    },
    listOpenByConversation(conversationId, limit) {
      return d
        .select()
        .from(schema.requirement)
        .where(
          and(
            eq(schema.requirement.originConversationId, conversationId),
            eq(schema.requirement.status, "open"),
          ),
        )
        .orderBy(desc(schema.requirement.createdAt))
        .limit(limit)
        .all()
        .map(toRow);
    },
    // Named per the repo's no-ReturnType rule: the join facts the read model uses.
    runsOf(id: string): RequirementRunFact[] {
      return d
        .select({
          runId: schema.agentRun.runId,
          agentId: schema.agentRun.agentId,
          status: schema.agentRun.status,
          terminalResult: schema.agentRun.terminalResult,
          createdAt: schema.agentRun.createdAt,
        })
        .from(schema.agentRun)
        .where(eq(schema.agentRun.requirementId, id))
        .orderBy(desc(schema.agentRun.createdAt))
        .all()
        .map((r) => ({
          runId: r.runId,
          agentId: r.agentId ?? null,
          status: r.status,
          verification: verificationOf(r.terminalResult ?? null),
          createdAt: r.createdAt,
        }));
    },
    requestsOf(id: string): RequirementRequestFact[] {
      // Single JOIN replaces the double scan + N+1 pending_action queries.
      return d
        .select({
          actionId: schema.pendingAction.actionId,
          runId: schema.pendingAction.runId,
          kind: schema.pendingAction.kind,
          status: schema.pendingAction.status,
          payload: schema.pendingAction.payload,
          owner: schema.pendingAction.owner,
        })
        .from(schema.pendingAction)
        .innerJoin(schema.agentRun, eq(schema.pendingAction.runId, schema.agentRun.runId))
        .where(eq(schema.agentRun.requirementId, id))
        .orderBy(desc(schema.agentRun.createdAt))
        .all()
        .map((row) => ({
          actionId: row.actionId,
          runId: row.runId,
          kind: row.kind,
          status: row.status,
          head: headOf(row.payload),
          owner: row.owner,
        }));
    },
    workflowExecutionsOf(id: string): RequirementWorkflowFact[] {
      return d
        .select({
          executionId: schema.workflowExecution.executionId,
          workflowId: schema.workflowExecution.workflowId,
          status: schema.workflowExecution.status,
          createdAt: schema.workflowExecution.createdAt,
          terminalAt: schema.workflowExecution.terminalAt,
        })
        .from(schema.workflowExecution)
        .where(eq(schema.workflowExecution.requirementId, id))
        .orderBy(desc(schema.workflowExecution.createdAt))
        .all()
        .map((row) => ({
          executionId: row.executionId,
          workflowId: row.workflowId,
          status: row.status,
          createdAt: row.createdAt,
          terminalAt: row.terminalAt ?? null,
        }));
    },
  };
}

function headOf(payload: string | null): string {
  if (payload === null) return "";
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== "object" || parsed === null) return "";
    const q = (parsed as { question?: unknown }).question;
    if (typeof q === "string" && q !== "") return q.slice(0, 120);
    const questions = (parsed as { questions?: unknown }).questions;
    if (Array.isArray(questions)) {
      const first = questions[0] as { question?: unknown } | undefined;
      if (typeof first?.question === "string" && first.question !== "") {
        return first.question.slice(0, 120);
      }
    }
    const reason = (parsed as { reason?: unknown }).reason;
    if (typeof reason === "string" && reason !== "") return reason.slice(0, 120);
    return "";
  } catch {
    return "";
  }
}
