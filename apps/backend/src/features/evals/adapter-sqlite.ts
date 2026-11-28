import type { Database } from "bun:sqlite";
import { and, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../infra/db/schema.js";
import type {
  EvalCaseResultRow,
  EvalRunRow,
  EvalRunStatus,
  EvalRunSummary,
  GraderOutcome,
  RunFeedbackRow,
} from "./domain.js";

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toEvalRunRow(r: typeof schema.evalRun.$inferSelect): EvalRunRow {
  return {
    evalRunId: r.evalRunId,
    suiteId: r.suiteId,
    suiteCommit: r.suiteCommit,
    label: r.label,
    targetKind: r.targetKind as EvalRunRow["targetKind"],
    targetRef: r.targetRef,
    modelRef: r.modelRef,
    status: r.status as EvalRunStatus,
    trials: r.trials,
    concurrency: r.concurrency,
    maxTotalCostUsd: r.maxTotalCostUsd !== null ? Number(r.maxTotalCostUsd) : null,
    summary: parseJson<EvalRunSummary | null>(r.summaryJson, null),
    error: r.error,
    createdAt: r.createdAt,
    terminalAt: r.terminalAt,
  };
}

function toCaseResultRow(r: typeof schema.evalCaseResult.$inferSelect): EvalCaseResultRow {
  return {
    resultId: r.resultId,
    evalRunId: r.evalRunId,
    caseId: r.caseId,
    trialIndex: r.trialIndex,
    runId: r.runId,
    workflowExecutionId: r.workflowExecutionId,
    passed: r.passed !== 0,
    score: Number(r.score),
    graderResults: parseJson<GraderOutcome[]>(r.graderResultsJson, []),
    activeDurationMs: r.activeDurationMs,
    toolCalls: r.toolCalls,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    costUsd: Number(r.costUsd),
    error: r.error,
    createdAt: r.createdAt,
    terminalAt: r.terminalAt,
  };
}

function toFeedbackRow(r: typeof schema.runFeedback.$inferSelect): RunFeedbackRow {
  return {
    feedbackId: r.feedbackId,
    runId: r.runId,
    workflowExecutionId: r.workflowExecutionId,
    rating: r.rating === "down" ? "down" : "up",
    tags: parseJson<string[]>(r.tagsJson, []),
    note: r.note,
    promotedSuiteId: r.promotedSuiteId,
    promotedCaseId: r.promotedCaseId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** SQLite store for `eval_run`, `eval_case_result`, and `run_feedback`. */
export class EvalSqliteStore {
  #d: ReturnType<typeof drizzle<typeof schema>>;

  constructor(db: Database) {
    this.#d = drizzle(db, { schema, casing: "snake_case" });
  }

  createEvalRun(input: {
    evalRunId: string;
    suiteId: string;
    suiteCommit: string | null;
    label?: string | null;
    targetKind: "skill" | "workflow" | "agent";
    targetRef: string;
    modelRef?: string | null;
    trials: number;
    concurrency: number;
    maxTotalCostUsd?: number | null;
    createdAt?: number;
  }): EvalRunRow {
    const now = input.createdAt ?? Date.now();
    this.#d
      .insert(schema.evalRun)
      .values({
        evalRunId: input.evalRunId,
        suiteId: input.suiteId,
        suiteCommit: input.suiteCommit,
        label: input.label ?? null,
        targetKind: input.targetKind,
        targetRef: input.targetRef,
        modelRef: input.modelRef ?? null,
        status: "running",
        trials: input.trials,
        concurrency: input.concurrency,
        maxTotalCostUsd:
          input.maxTotalCostUsd !== undefined && input.maxTotalCostUsd !== null
            ? String(input.maxTotalCostUsd)
            : null,
        createdAt: now,
      })
      .run();
    return this.getEvalRun(input.evalRunId)!;
  }

  finishEvalRun(input: {
    evalRunId: string;
    status: EvalRunStatus;
    summary: EvalRunSummary;
    error?: string | null;
    terminalAt?: number;
  }): EvalRunRow | undefined {
    this.#d
      .update(schema.evalRun)
      .set({
        status: input.status,
        summaryJson: JSON.stringify(input.summary),
        error: input.error ?? null,
        terminalAt: input.terminalAt ?? Date.now(),
      })
      .where(eq(schema.evalRun.evalRunId, input.evalRunId))
      .run();
    return this.getEvalRun(input.evalRunId);
  }

  getEvalRun(evalRunId: string): EvalRunRow | undefined {
    const row = this.#d
      .select()
      .from(schema.evalRun)
      .where(eq(schema.evalRun.evalRunId, evalRunId))
      .get();
    return row ? toEvalRunRow(row) : undefined;
  }

  listEvalRuns(filter?: {
    suiteId?: string;
    targetKind?: "skill" | "workflow" | "agent";
    targetRef?: string;
    limit?: number;
  }): EvalRunRow[] {
    const conds = [];
    if (filter?.suiteId) conds.push(eq(schema.evalRun.suiteId, filter.suiteId));
    if (filter?.targetKind) conds.push(eq(schema.evalRun.targetKind, filter.targetKind));
    if (filter?.targetRef) conds.push(eq(schema.evalRun.targetRef, filter.targetRef));
    const q = this.#d
      .select()
      .from(schema.evalRun)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(schema.evalRun.createdAt))
      .limit(filter?.limit ?? 50);
    return q.all().map(toEvalRunRow);
  }

  recordCaseResult(input: {
    resultId: string;
    evalRunId: string;
    caseId: string;
    trialIndex: number;
    runId?: string | null;
    workflowExecutionId?: string | null;
    passed: boolean;
    score: number;
    graderResults: readonly GraderOutcome[];
    activeDurationMs?: number | null;
    toolCalls?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    costUsd?: number;
    error?: string | null;
    createdAt: number;
    terminalAt?: number | null;
  }): EvalCaseResultRow {
    this.#d
      .insert(schema.evalCaseResult)
      .values({
        resultId: input.resultId,
        evalRunId: input.evalRunId,
        caseId: input.caseId,
        trialIndex: input.trialIndex,
        runId: input.runId ?? null,
        workflowExecutionId: input.workflowExecutionId ?? null,
        passed: input.passed ? 1 : 0,
        score: String(input.score),
        graderResultsJson: JSON.stringify(input.graderResults),
        activeDurationMs: input.activeDurationMs ?? null,
        toolCalls: input.toolCalls ?? 0,
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        cacheReadTokens: input.cacheReadTokens ?? 0,
        costUsd: String(input.costUsd ?? 0),
        error: input.error ?? null,
        createdAt: input.createdAt,
        terminalAt: input.terminalAt ?? Date.now(),
      })
      .run();
    return this.listCaseResults(input.evalRunId).find((r) => r.resultId === input.resultId)!;
  }

  listCaseResults(evalRunId: string): EvalCaseResultRow[] {
    return this.#d
      .select()
      .from(schema.evalCaseResult)
      .where(eq(schema.evalCaseResult.evalRunId, evalRunId))
      .all()
      .map(toCaseResultRow);
  }

  // ─── run_feedback (ADR 0085 D7) ───

  saveFeedback(input: {
    feedbackId: string;
    runId?: string | null;
    workflowExecutionId?: string | null;
    rating: "up" | "down";
    tags?: readonly string[];
    note?: string | null;
    promotedSuiteId?: string | null;
    promotedCaseId?: string | null;
  }): RunFeedbackRow {
    const now = Date.now();
    this.#d
      .insert(schema.runFeedback)
      .values({
        feedbackId: input.feedbackId,
        runId: input.runId ?? null,
        workflowExecutionId: input.workflowExecutionId ?? null,
        rating: input.rating,
        tagsJson: JSON.stringify(input.tags ?? []),
        note: input.note ?? null,
        promotedSuiteId: input.promotedSuiteId ?? null,
        promotedCaseId: input.promotedCaseId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.runFeedback.feedbackId,
        set: {
          rating: input.rating,
          tagsJson: JSON.stringify(input.tags ?? []),
          note: input.note ?? null,
          promotedSuiteId: input.promotedSuiteId ?? null,
          promotedCaseId: input.promotedCaseId ?? null,
          updatedAt: now,
        },
      })
      .run();
    return this.#d
      .select()
      .from(schema.runFeedback)
      .where(eq(schema.runFeedback.feedbackId, input.feedbackId))
      .get()!
      ? toFeedbackRow(
          this.#d
            .select()
            .from(schema.runFeedback)
            .where(eq(schema.runFeedback.feedbackId, input.feedbackId))
            .get()!,
        )
      : (() => {
          throw new Error("feedback insert failed");
        })();
  }

  listFeedback(filter?: {
    runId?: string;
    workflowExecutionId?: string;
    rating?: "up" | "down";
    limit?: number;
  }): RunFeedbackRow[] {
    const conds = [];
    if (filter?.runId) conds.push(eq(schema.runFeedback.runId, filter.runId));
    if (filter?.workflowExecutionId) {
      conds.push(eq(schema.runFeedback.workflowExecutionId, filter.workflowExecutionId));
    }
    if (filter?.rating) conds.push(eq(schema.runFeedback.rating, filter.rating));
    return this.#d
      .select()
      .from(schema.runFeedback)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(schema.runFeedback.createdAt))
      .limit(filter?.limit ?? 100)
      .all()
      .map(toFeedbackRow);
  }
}
