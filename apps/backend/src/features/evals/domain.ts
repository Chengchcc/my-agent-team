import { z } from "zod";

export const EVAL_SUITE_ID_RE = /^[A-Za-z0-9._-]+$/;

// ─── Grader specifications (ADR 0085 D5: 3 layers) ─────────────────────────

export const skillActivatedGraderSchema = z.object({
  type: z.literal("skill_activated"),
  skillName: z.string().min(1),
  /** Default true = skill MUST be activated; false = skill must NOT be activated. */
  expected: z.boolean().optional().default(true),
});

export const toolCalledGraderSchema = z.object({
  type: z.literal("tool_called"),
  toolName: z.string().min(1),
  /** Optional substring match on serialized tool input. */
  argsMatch: z.string().optional(),
  minCalls: z.number().int().min(1).optional().default(1),
});

export const toolForbiddenGraderSchema = z.object({
  type: z.literal("tool_forbidden"),
  toolName: z.string().min(1),
});

export const workflowOutcomeGraderSchema = z.object({
  type: z.literal("workflow_outcome"),
  expectedStatus: z.enum(["success", "failure", "custom", "waiting_human"]).optional(),
  expectedExit: z.string().optional(),
  requiredNodes: z.array(z.string().min(1)).optional(),
  forbiddenNodes: z.array(z.string().min(1)).optional(),
  forbidBudgetExhausted: z.boolean().optional().default(true),
});

export const outputMatchGraderSchema = z.object({
  type: z.literal("output_match"),
  contains: z.array(z.string().min(1)).optional(),
  notContains: z.array(z.string().min(1)).optional(),
  regex: z.string().optional(),
  /** Optional JSON-path / field equality assertions when output is JSON. */
  jsonEquals: z.record(z.string(), z.unknown()).optional(),
});

export const commandCheckGraderSchema = z.object({
  type: z.literal("command_check"),
  command: z.string().min(1),
  timeoutMs: z.number().int().min(1000).max(120_000).optional().default(30_000),
});

export const llmJudgeGraderSchema = z.object({
  type: z.literal("llm_judge"),
  rubric: z.string().min(1),
  minScore: z.number().min(1).max(5).optional().default(4),
  modelId: z.string().optional(),
});

export const graderSpecSchema = z.discriminatedUnion("type", [
  skillActivatedGraderSchema,
  toolCalledGraderSchema,
  toolForbiddenGraderSchema,
  workflowOutcomeGraderSchema,
  outputMatchGraderSchema,
  commandCheckGraderSchema,
  llmJudgeGraderSchema,
]);

export type GraderSpec = z.infer<typeof graderSpecSchema>;

export const evalCaseBudgetSchema = z.object({
  maxDurationMs: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
});

export const evalCaseFixtureSchema = z.object({
  projectId: z.string().min(1).optional(),
  ref: z.string().min(1).optional(),
  files: z.record(z.string(), z.string()).optional(),
});

export const evalCaseSchema = z.object({
  id: z.string().regex(EVAL_SUITE_ID_RE, "case id must match [A-Za-z0-9._-]+"),
  name: z.string().min(1),
  tags: z.array(z.string()).optional().default([]),
  /** Natural-language message for `skill`/`agent` targets, or JSON object for `workflow`. */
  input: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
  fixture: evalCaseFixtureSchema.optional(),
  graders: z.array(graderSpecSchema).min(1),
  budget: evalCaseBudgetSchema.optional(),
  trials: z.number().int().min(1).max(10).optional(),
});

export type EvalCase = z.infer<typeof evalCaseSchema>;

export const evalTargetSchema = z.object({
  kind: z.enum(["skill", "workflow", "agent"]),
  /** skillName for skill, workflowId for workflow, agentId for agent. */
  ref: z.string().min(1),
  /** Optional agentId override when target.kind === "skill". */
  agentId: z.string().min(1).optional(),
});

export type EvalTarget = z.infer<typeof evalTargetSchema>;

export const evalSuiteSchema = z.object({
  id: z.string().regex(EVAL_SUITE_ID_RE, "suite id must match [A-Za-z0-9._-]+"),
  name: z.string().min(1),
  description: z.string().optional().default(""),
  target: evalTargetSchema,
  defaultModel: z.string().optional(),
  defaultTrials: z.number().int().min(1).max(10).optional().default(1),
  budget: z
    .object({
      maxTotalCostUsd: z.number().positive().optional(),
      concurrency: z.number().int().min(1).max(8).optional().default(2),
    })
    .optional(),
  cases: z.array(evalCaseSchema).min(1),
});

export type EvalSuite = z.infer<typeof evalSuiteSchema>;

export function parseEvalSuite(raw: unknown): EvalSuite {
  const parsed = evalSuiteSchema.parse(raw);
  const seenIds = new Set<string>();
  for (const c of parsed.cases) {
    if (seenIds.has(c.id)) {
      throw new Error(`Duplicate eval case id "${c.id}" in suite "${parsed.id}"`);
    }
    seenIds.add(c.id);
  }
  return parsed;
}

// ─── Execution results & A/B Diff types ────────────────────────────────────

export interface GraderOutcome {
  readonly type: string;
  readonly label: string;
  readonly passed: boolean;
  readonly score: number; // 0..1
  readonly reason: string;
}

export interface EvalRunSummary {
  readonly totalCases: number;
  readonly totalTrials: number;
  readonly passedTrials: number;
  readonly passRate: number; // 0..1
  readonly passAtK: number; // fraction of cases with >= 1 passing trial
  readonly passPowK: number; // fraction of cases where ALL k trials passed
  readonly avgScore: number; // 0..1
  readonly totalCostUsd: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCacheReadTokens: number;
  readonly cacheHitRate: number | null;
  readonly p50DurationMs: number | null;
  readonly p95DurationMs: number | null;
}

export type EvalRunStatus = "running" | "completed" | "failed" | "cancelled" | "budget_stopped";

export interface EvalRunRow {
  readonly evalRunId: string;
  readonly suiteId: string;
  readonly suiteCommit: string | null;
  readonly label: string | null;
  readonly targetKind: "skill" | "workflow" | "agent";
  readonly targetRef: string;
  readonly modelRef: string | null;
  readonly status: EvalRunStatus;
  readonly trials: number;
  readonly concurrency: number;
  readonly maxTotalCostUsd: number | null;
  readonly summary: EvalRunSummary | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly terminalAt: number | null;
}

export interface EvalCaseResultRow {
  readonly resultId: string;
  readonly evalRunId: string;
  readonly caseId: string;
  readonly trialIndex: number;
  readonly runId: string | null;
  readonly workflowExecutionId: string | null;
  readonly passed: boolean;
  readonly score: number;
  readonly graderResults: GraderOutcome[];
  readonly activeDurationMs: number | null;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly costUsd: number;
  readonly error: string | null;
  readonly createdAt: number;
  readonly terminalAt: number | null;
}

export interface RunFeedbackRow {
  readonly feedbackId: string;
  readonly runId: string | null;
  readonly workflowExecutionId: string | null;
  readonly rating: "up" | "down";
  readonly tags: string[];
  readonly note: string | null;
  readonly promotedSuiteId: string | null;
  readonly promotedCaseId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Compute pass@k, pass^k, latency percentiles, and cost summary from trial rows. */
export function summarizeEvalResults(results: readonly EvalCaseResultRow[]): EvalRunSummary {
  const byCase = new Map<string, EvalCaseResultRow[]>();
  for (const r of results) {
    const list = byCase.get(r.caseId) ?? [];
    list.push(r);
    byCase.set(r.caseId, list);
  }
  const totalCases = byCase.size;
  const totalTrials = results.length;
  let passedTrials = 0;
  let scoreSum = 0;
  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  const durations: number[] = [];

  for (const r of results) {
    if (r.passed) passedTrials++;
    scoreSum += r.score;
    totalCostUsd += r.costUsd;
    totalInputTokens += r.inputTokens;
    totalOutputTokens += r.outputTokens;
    totalCacheReadTokens += r.cacheReadTokens;
    if (r.activeDurationMs !== null) durations.push(r.activeDurationMs);
  }

  let casesWithAnyPass = 0;
  let casesWithAllPass = 0;
  for (const trials of byCase.values()) {
    if (trials.some((t) => t.passed)) casesWithAnyPass++;
    if (trials.length > 0 && trials.every((t) => t.passed)) casesWithAllPass++;
  }

  const pct = (p: number): number | null => {
    if (durations.length === 0) return null;
    const sorted = [...durations].sort((a, b) => a - b);
    const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return Math.round(sorted[rank]!);
  };

  const cacheDenom = totalInputTokens + totalCacheReadTokens;
  return {
    totalCases,
    totalTrials,
    passedTrials,
    passRate: totalTrials > 0 ? passedTrials / totalTrials : 0,
    passAtK: totalCases > 0 ? casesWithAnyPass / totalCases : 0,
    passPowK: totalCases > 0 ? casesWithAllPass / totalCases : 0,
    avgScore: totalTrials > 0 ? scoreSum / totalTrials : 0,
    totalCostUsd,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    cacheHitRate: cacheDenom > 0 ? totalCacheReadTokens / cacheDenom : null,
    p50DurationMs: pct(50),
    p95DurationMs: pct(95),
  };
}

export interface EvalCaseDiffItem {
  readonly caseId: string;
  readonly change:
    | "regressed"
    | "improved"
    | "unchanged_pass"
    | "unchanged_fail"
    | "added"
    | "removed";
  readonly baselinePassRate: number | null;
  readonly candidatePassRate: number | null;
  readonly baselineRunId: string | null;
  readonly candidateRunId: string | null;
  readonly baselineAvgDurationMs: number | null;
  readonly candidateAvgDurationMs: number | null;
  readonly baselineCostUsd: number;
  readonly candidateCostUsd: number;
}

export interface EvalRunDiff {
  readonly baseline: EvalRunRow;
  readonly candidate: EvalRunRow;
  readonly deltaPassRate: number;
  readonly deltaPassPowK: number;
  readonly deltaCostUsd: number;
  readonly deltaP95DurationMs: number | null;
  readonly regressions: number;
  readonly improvements: number;
  readonly cases: EvalCaseDiffItem[];
}

/** ADR 0085 D5: Side-by-side Baseline vs Candidate diff, sorting regressions first. */
export function diffEvalRuns(
  baseline: EvalRunRow,
  baselineResults: readonly EvalCaseResultRow[],
  candidate: EvalRunRow,
  candidateResults: readonly EvalCaseResultRow[],
): EvalRunDiff {
  const group = (rows: readonly EvalCaseResultRow[]) => {
    const m = new Map<string, EvalCaseResultRow[]>();
    for (const r of rows) {
      const list = m.get(r.caseId) ?? [];
      list.push(r);
      m.set(r.caseId, list);
    }
    return m;
  };
  const bMap = group(baselineResults);
  const cMap = group(candidateResults);
  const allCaseIds = [...new Set([...bMap.keys(), ...cMap.keys()])].sort();

  const rateOf = (rows: EvalCaseResultRow[] | undefined): number | null => {
    if (!rows || rows.length === 0) return null;
    return rows.filter((r) => r.passed).length / rows.length;
  };
  const avgDurOf = (rows: EvalCaseResultRow[] | undefined): number | null => {
    if (!rows) return null;
    const vals = rows.map((r) => r.activeDurationMs).filter((v): v is number => v !== null);
    return vals.length > 0 ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
  };
  const costOf = (rows: EvalCaseResultRow[] | undefined): number =>
    rows ? rows.reduce((s, r) => s + r.costUsd, 0) : 0;

  let regressions = 0;
  let improvements = 0;
  const cases: EvalCaseDiffItem[] = [];
  for (const caseId of allCaseIds) {
    const bRows = bMap.get(caseId);
    const cRows = cMap.get(caseId);
    const bRate = rateOf(bRows);
    const cRate = rateOf(cRows);
    let change: EvalCaseDiffItem["change"];
    if (bRate === null) {
      change = "added";
    } else if (cRate === null) {
      change = "removed";
    } else if (cRate < bRate) {
      change = "regressed";
      regressions++;
    } else if (cRate > bRate) {
      change = "improved";
      improvements++;
    } else {
      change = cRate >= 1 ? "unchanged_pass" : "unchanged_fail";
    }
    cases.push({
      caseId,
      change,
      baselinePassRate: bRate,
      candidatePassRate: cRate,
      baselineRunId: bRows?.[0]?.runId ?? null,
      candidateRunId: cRows?.[0]?.runId ?? null,
      baselineAvgDurationMs: avgDurOf(bRows),
      candidateAvgDurationMs: avgDurOf(cRows),
      baselineCostUsd: costOf(bRows),
      candidateCostUsd: costOf(cRows),
    });
  }

  const order: Record<EvalCaseDiffItem["change"], number> = {
    regressed: 0,
    improved: 1,
    unchanged_fail: 2,
    added: 3,
    removed: 4,
    unchanged_pass: 5,
  };
  cases.sort((a, b) => order[a.change] - order[b.change] || a.caseId.localeCompare(b.caseId));

  const bSum = baseline.summary ?? summarizeEvalResults(baselineResults);
  const cSum = candidate.summary ?? summarizeEvalResults(candidateResults);

  return {
    baseline,
    candidate,
    deltaPassRate: cSum.passRate - bSum.passRate,
    deltaPassPowK: cSum.passPowK - bSum.passPowK,
    deltaCostUsd: cSum.totalCostUsd - bSum.totalCostUsd,
    deltaP95DurationMs:
      bSum.p95DurationMs !== null && cSum.p95DurationMs !== null
        ? cSum.p95DurationMs - bSum.p95DurationMs
        : null,
    regressions,
    improvements,
    cases,
  };
}
