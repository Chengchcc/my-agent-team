import type { Database } from "bun:sqlite";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import type {
  RequirementPatch,
  RequirementRequestFact,
  RequirementRow,
  RequirementRunFact,
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
    title: r.title,
    goal: r.goal,
    background: r.background ?? null,
    constraints: r.constraints ?? null,
    expectedDeliverables: r.expectedDeliverables ?? null,
    acceptanceCriteria: r.acceptanceCriteria ?? null,
    status: r.status === "done" || r.status === "cancelled" ? r.status : "open",
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
      const updated = d
        .update(schema.requirement)
        .set({ ...patch, updatedAt: now })
        .where(eq(schema.requirement.requirementId, id))
        .returning()
        .get();
      return updated ? toRow(updated) : null;
    },
    list(includeClosed) {
      const rows = d
        .select()
        .from(schema.requirement)
        .orderBy(desc(schema.requirement.updatedAt))
        .all();
      const all = rows.map(toRow);
      return includeClosed ? all : all.filter((r) => r.status === "open");
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
      // Pending actions hang off runs; a requirement's requests are its runs'.
      const runs = this.runsOf(id);
      if (runs.length === 0) return [];
      const out: RequirementRequestFact[] = [];
      for (const run of runs) {
        const rows = d
          .select()
          .from(schema.pendingAction)
          .where(eq(schema.pendingAction.runId, run.runId))
          .all();
        for (const row of rows) {
          out.push({
            actionId: row.actionId,
            runId: row.runId,
            kind: row.kind,
            status: row.status,
            head: headOf(row.payload),
          });
        }
      }
      return out;
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
    const reason = (parsed as { reason?: unknown }).reason;
    if (typeof reason === "string" && reason !== "") return reason.slice(0, 120);
    return "";
  } catch {
    return "";
  }
}
