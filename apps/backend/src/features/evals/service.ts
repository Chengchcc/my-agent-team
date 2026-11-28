import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NotFoundError, ValidationError } from "../../infra/domain-errors.js";
import { GOLDEN_INTENT_CASES } from "../product-tools/golden-intent.cases.js";
import type { EvalSqliteStore } from "./adapter-sqlite.js";
import {
  diffEvalRuns,
  type EvalCase,
  type EvalCaseResultRow,
  type EvalRunDiff,
  type EvalRunRow,
  type EvalRunStatus,
  type EvalSuite,
  type GraderSpec,
  type RunFeedbackRow,
  summarizeEvalResults,
} from "./domain.js";
import { type GraderRuntimeDeps, gradeEvalTrial, type TrialObservation } from "./graders.js";
import type { EvalSuiteCommitInfo, EvalSuiteStore } from "./suite-store.js";

export interface EvalCaseExecutionResult {
  readonly runId?: string | null;
  readonly workflowExecutionId?: string | null;
  readonly observation: TrialObservation;
}

export interface EvalExecutionHooks {
  /** Execute a `skill` or `agent` eval case trial through the real Agent Run
   *  pipeline with `authorization = "eval:<evalRunId>"`. */
  readonly runAgentCase: (input: {
    evalRunId: string;
    suite: EvalSuite;
    evalCase: EvalCase;
    trialIndex: number;
    modelOverride?: string;
    workDir?: string;
  }) => Promise<EvalCaseExecutionResult>;
  /** Execute a `workflow` eval case trial through the real Workflow engine
   *  with `triggeredBy = "eval:<evalRunId>"`. */
  readonly runWorkflowCase: (input: {
    evalRunId: string;
    suite: EvalSuite;
    evalCase: EvalCase;
    trialIndex: number;
    modelOverride?: string;
    workDir?: string;
  }) => Promise<EvalCaseExecutionResult>;
  /** Optional isolated worktree preparation for cases declaring `fixture.projectId`. */
  readonly prepareProjectWorktree?: (input: {
    projectId: string;
    ref?: string;
    evalRunId: string;
    caseId: string;
  }) => Promise<{ path: string; cleanup: () => Promise<void> }>;
  /** Optional command runner & LLM judge passed to `gradeEvalTrial`. */
  readonly graders?: GraderRuntimeDeps;
}

export interface EvalServiceDeps {
  readonly db: Database;
  readonly suiteStore: EvalSuiteStore;
  readonly sqliteStore: EvalSqliteStore;
  readonly ulid: () => string;
  readonly execution: EvalExecutionHooks;
}

/** Built-in showcase suite derived from ADR 0057's `GOLDEN_INTENT_CASES` so
 *  `/system/evals` is immediately useful out of the box. */
export function buildDefaultRoutingSuite(frontAgentId: string): EvalSuite {
  return {
    id: "front-desk-routing",
    name: "Front Desk Routing (ADR 0057)",
    description:
      "Regression suite checking front-desk answer / ask / dispatch routing discipline across representative requests.",
    target: { kind: "agent", ref: frontAgentId },
    defaultTrials: 1,
    budget: { concurrency: 2, maxTotalCostUsd: 0.5 },
    cases: GOLDEN_INTENT_CASES.slice(0, 8).map((c, idx) => {
      const graders: GraderSpec[] = [];
      if (c.expected.action === "dispatch") {
        graders.push({ type: "tool_called", toolName: "dispatch", minCalls: 1 });
      } else if (c.expected.action === "ask") {
        graders.push({ type: "tool_called", toolName: "ask_question", minCalls: 1 });
      } else {
        graders.push({ type: "tool_forbidden", toolName: "dispatch" });
        graders.push({ type: "tool_forbidden", toolName: "ask_question" });
      }
      const verbTag = "verb" in c.expected ? [c.expected.verb] : [];
      return {
        id: `golden-${String(idx + 1).padStart(2, "0")}`,
        name: c.message.slice(0, 48),
        tags: ["routing", c.expected.action, ...verbTag],
        input: c.message,
        graders,
        budget: { maxDurationMs: 60_000, maxToolCalls: 8, maxCostUsd: 0.08 },
      };
    }),
  };
}

export function createEvalService(deps: EvalServiceDeps) {
  const { db, suiteStore, sqliteStore, ulid, execution } = deps;
  const cancelledRuns = new Set<string>();
  const inflightRuns = new Map<string, Promise<EvalRunRow>>();

  async function prepareWorkDir(
    evalRunId: string,
    evalCase: EvalCase,
  ): Promise<{ workDir?: string; cleanup: () => Promise<void> }> {
    const fixture = evalCase.fixture;
    if (!fixture) return { cleanup: async () => {} };

    let dir: string;
    let baseCleanup: () => Promise<void>;
    if (fixture.projectId && execution.prepareProjectWorktree) {
      const wt = await execution.prepareProjectWorktree({
        projectId: fixture.projectId,
        ref: fixture.ref,
        evalRunId,
        caseId: evalCase.id,
      });
      dir = wt.path;
      baseCleanup = wt.cleanup;
    } else {
      dir = mkdtempSync(join(tmpdir(), `crewdesk-eval-${evalCase.id}-`));
      baseCleanup = async () => {
        rmSync(dir, { recursive: true, force: true });
      };
    }

    if (fixture.files) {
      for (const [relPath, content] of Object.entries(fixture.files)) {
        const clean = relPath.replace(/^[/\\]+/, "");
        if (clean.includes("..")) continue;
        const abs = join(dir, clean);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, "utf8");
      }
    }

    return { workDir: dir, cleanup: baseCleanup };
  }

  async function executeEvalRun(
    evalRunId: string,
    suite: EvalSuite,
    casesToRun: readonly EvalCase[],
    opts: {
      trials: number;
      concurrency: number;
      maxTotalCostUsd: number | null;
      modelOverride?: string;
    },
  ): Promise<EvalRunRow> {
    const workItems: Array<{ evalCase: EvalCase; trialIndex: number }> = [];
    for (const evalCase of casesToRun) {
      const k = evalCase.trials ?? opts.trials;
      for (let t = 0; t < k; t++) {
        workItems.push({ evalCase, trialIndex: t });
      }
    }

    let cursor = 0;
    let spentUsd = 0;
    let budgetStopped = false;
    const results: EvalCaseResultRow[] = [];

    const worker = async () => {
      while (true) {
        if (cancelledRuns.has(evalRunId)) return;
        if (opts.maxTotalCostUsd !== null && spentUsd >= opts.maxTotalCostUsd) {
          budgetStopped = true;
          return;
        }
        const idx = cursor++;
        const item = workItems[idx];
        if (!item) return;

        const startedAt = Date.now();
        const { workDir, cleanup } = await prepareWorkDir(evalRunId, item.evalCase);
        try {
          const execRes =
            suite.target.kind === "workflow"
              ? await execution.runWorkflowCase({
                  evalRunId,
                  suite,
                  evalCase: item.evalCase,
                  trialIndex: item.trialIndex,
                  modelOverride: opts.modelOverride ?? suite.defaultModel,
                  workDir,
                })
              : await execution.runAgentCase({
                  evalRunId,
                  suite,
                  evalCase: item.evalCase,
                  trialIndex: item.trialIndex,
                  modelOverride: opts.modelOverride ?? suite.defaultModel,
                  workDir,
                });

          const obs: TrialObservation = {
            ...execRes.observation,
            ...(workDir ? { workDir } : {}),
          };
          const graded = await gradeEvalTrial(item.evalCase, obs, execution.graders);
          spentUsd += obs.costUsd;
          const row = sqliteStore.recordCaseResult({
            resultId: ulid(),
            evalRunId,
            caseId: item.evalCase.id,
            trialIndex: item.trialIndex,
            runId: execRes.runId ?? null,
            workflowExecutionId: execRes.workflowExecutionId ?? null,
            passed: graded.passed,
            score: graded.score,
            graderResults: graded.graderResults,
            activeDurationMs: obs.activeDurationMs,
            toolCalls: obs.toolCalls,
            inputTokens: obs.inputTokens,
            outputTokens: obs.outputTokens,
            cacheReadTokens: obs.cacheReadTokens,
            costUsd: obs.costUsd,
            error: obs.error,
            createdAt: startedAt,
            terminalAt: Date.now(),
          });
          results.push(row);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const row = sqliteStore.recordCaseResult({
            resultId: ulid(),
            evalRunId,
            caseId: item.evalCase.id,
            trialIndex: item.trialIndex,
            passed: false,
            score: 0,
            graderResults: [
              { type: "execution", label: "execution", passed: false, score: 0, reason: msg },
            ],
            activeDurationMs: Date.now() - startedAt,
            error: msg,
            createdAt: startedAt,
            terminalAt: Date.now(),
          });
          results.push(row);
        } finally {
          await cleanup().catch(() => {});
        }
      }
    };

    const poolSize = Math.min(Math.max(1, opts.concurrency), Math.max(1, workItems.length), 8);
    await Promise.all(Array.from({ length: poolSize }, () => worker()));

    const finalStatus: EvalRunStatus = cancelledRuns.has(evalRunId)
      ? "cancelled"
      : budgetStopped
        ? "budget_stopped"
        : "completed";
    cancelledRuns.delete(evalRunId);

    const summary = summarizeEvalResults(results);
    return (
      sqliteStore.finishEvalRun({
        evalRunId,
        status: finalStatus,
        summary,
        error: budgetStopped
          ? `Stopped after spending $${spentUsd.toFixed(4)} (cap $${opts.maxTotalCostUsd})`
          : null,
      }) ?? sqliteStore.getEvalRun(evalRunId)!
    );
  }

  return {
    // ─── Suite CRUD + Git history ───

    listSuites() {
      return suiteStore.listSuites().map((suite) => {
        const latest = sqliteStore.listEvalRuns({ suiteId: suite.id, limit: 1 })[0] ?? null;
        return {
          ...suite,
          commit: suiteStore.headCommit(suite.id),
          latestRun: latest,
        };
      });
    },

    getSuite(suiteId: string) {
      const suite = suiteStore.readParsed(suiteId);
      if (!suite) throw new NotFoundError("EvalSuite", suiteId);
      return {
        suite,
        commit: suiteStore.headCommit(suiteId),
        history: suiteStore.history(suiteId, 20),
        recentRuns: sqliteStore.listEvalRuns({ suiteId, limit: 20 }),
      };
    },

    saveSuite(suiteId: string, body: unknown, commit?: Partial<EvalSuiteCommitInfo>) {
      try {
        return suiteStore.write(suiteId, body, {
          author: commit?.author ?? "user",
          summary: commit?.summary ?? `Update eval suite ${suiteId}`,
        });
      } catch (err) {
        throw new ValidationError(err instanceof Error ? err.message : String(err));
      }
    },

    deleteSuite(suiteId: string, author = "user") {
      const removed = suiteStore.remove(suiteId, {
        author,
        summary: `Delete eval suite ${suiteId}`,
      });
      if (!removed) throw new NotFoundError("EvalSuite", suiteId);
      return { ok: true, suiteId };
    },

    suiteHistory(suiteId: string, limit = 20) {
      if (!suiteStore.exists(suiteId)) throw new NotFoundError("EvalSuite", suiteId);
      return { suiteId, history: suiteStore.history(suiteId, limit) };
    },

    revertSuite(suiteId: string, commitHash: string, author = "user") {
      try {
        return suiteStore.revert(suiteId, commitHash, {
          author,
          summary: `Revert eval suite ${suiteId} to ${commitHash.slice(0, 8)}`,
        });
      } catch (err) {
        throw new ValidationError(err instanceof Error ? err.message : String(err));
      }
    },

    seedDefaultRoutingSuite(frontAgentId: string) {
      if (suiteStore.exists("front-desk-routing")) return null;
      return suiteStore.write("front-desk-routing", buildDefaultRoutingSuite(frontAgentId), {
        author: "system",
        summary: "Seed built-in front-desk-routing eval suite (ADR 0085)",
      });
    },

    // ─── EvalRun lifecycle & A/B Diff ───

    startEvalRun(
      suiteId: string,
      opts?: {
        label?: string;
        modelOverride?: string;
        trials?: number;
        concurrency?: number;
        maxTotalCostUsd?: number | null;
        caseIds?: readonly string[];
        rerunFailedFrom?: string;
        /** For tests: await completion inline instead of backgrounding. */
        wait?: boolean;
      },
    ): Promise<EvalRunRow> {
      const suite = suiteStore.readParsed(suiteId);
      if (!suite) throw new NotFoundError("EvalSuite", suiteId);

      let selectedCaseIds: Set<string> | null = opts?.caseIds?.length
        ? new Set(opts.caseIds)
        : null;
      if (opts?.rerunFailedFrom) {
        const prior = sqliteStore.listCaseResults(opts.rerunFailedFrom);
        const failedIds = new Set(prior.filter((r) => !r.passed).map((r) => r.caseId));
        if (failedIds.size === 0) {
          throw new ValidationError("No failed cases to rerun from the referenced eval run");
        }
        selectedCaseIds = failedIds;
      }

      const casesToRun = selectedCaseIds
        ? suite.cases.filter((c) => selectedCaseIds!.has(c.id))
        : suite.cases;
      if (casesToRun.length === 0) {
        throw new ValidationError("No matching cases found in suite");
      }

      const trials = Math.min(Math.max(1, opts?.trials ?? suite.defaultTrials ?? 1), 10);
      const concurrency = Math.min(
        Math.max(1, opts?.concurrency ?? suite.budget?.concurrency ?? 2),
        8,
      );
      const maxTotalCostUsd =
        opts?.maxTotalCostUsd !== undefined
          ? opts.maxTotalCostUsd
          : (suite.budget?.maxTotalCostUsd ?? null);

      const evalRunId = ulid();
      const row = sqliteStore.createEvalRun({
        evalRunId,
        suiteId: suite.id,
        suiteCommit: suiteStore.headCommit(suite.id),
        label: opts?.label ?? null,
        targetKind: suite.target.kind,
        targetRef: suite.target.ref,
        modelRef: opts?.modelOverride ?? suite.defaultModel ?? null,
        trials,
        concurrency,
        maxTotalCostUsd,
      });

      const task = executeEvalRun(evalRunId, suite, casesToRun, {
        trials,
        concurrency,
        maxTotalCostUsd,
        modelOverride: opts?.modelOverride,
      }).finally(() => {
        inflightRuns.delete(evalRunId);
      });
      inflightRuns.set(evalRunId, task);

      return opts?.wait ? task : Promise.resolve(row);
    },

    cancelEvalRun(evalRunId: string) {
      const existing = sqliteStore.getEvalRun(evalRunId);
      if (!existing) throw new NotFoundError("EvalRun", evalRunId);
      if (existing.status !== "running") return existing;
      cancelledRuns.add(evalRunId);
      return existing;
    },

    listEvalRuns(filter?: {
      suiteId?: string;
      targetKind?: "skill" | "workflow" | "agent";
      targetRef?: string;
      limit?: number;
    }) {
      return sqliteStore.listEvalRuns(filter);
    },

    getEvalRun(evalRunId: string) {
      const run = sqliteStore.getEvalRun(evalRunId);
      if (!run) throw new NotFoundError("EvalRun", evalRunId);
      const results = sqliteStore.listCaseResults(evalRunId);
      return { run, results };
    },

    diffRuns(baselineId: string, candidateId: string): EvalRunDiff {
      const baseline = sqliteStore.getEvalRun(baselineId);
      if (!baseline) throw new NotFoundError("EvalRun", baselineId);
      const candidate = sqliteStore.getEvalRun(candidateId);
      if (!candidate) throw new NotFoundError("EvalRun", candidateId);
      return diffEvalRuns(
        baseline,
        sqliteStore.listCaseResults(baselineId),
        candidate,
        sqliteStore.listCaseResults(candidateId),
      );
    },

    /** Wait for any in-flight eval runs (useful for graceful shutdown & tests). */
    async drainInflight() {
      await Promise.allSettled([...inflightRuns.values()]);
    },

    // ─── Feedback & Production-to-Eval Flywheel (ADR 0085 D7) ───

    saveFeedback(input: {
      feedbackId?: string;
      runId?: string | null;
      workflowExecutionId?: string | null;
      rating: "up" | "down";
      tags?: readonly string[];
      note?: string | null;
      promotedSuiteId?: string | null;
      promotedCaseId?: string | null;
    }): RunFeedbackRow {
      if (!input.runId && !input.workflowExecutionId) {
        throw new ValidationError("Either runId or workflowExecutionId is required");
      }
      return sqliteStore.saveFeedback({
        ...input,
        feedbackId: input.feedbackId ?? ulid(),
      });
    },

    listFeedback(filter?: {
      runId?: string;
      workflowExecutionId?: string;
      rating?: "up" | "down";
      limit?: number;
    }) {
      return sqliteStore.listFeedback(filter);
    },

    /** ADR 0085 D7: Promote a production Agent Run or Workflow Execution into a
     *  versioned `<dataDir>/evals/<suiteId>.eval.json` regression case. */
    promoteToEvalCase(input: {
      runId?: string;
      workflowExecutionId?: string;
      suiteId: string;
      suiteName?: string;
      caseId?: string;
      caseName?: string;
      tags?: readonly string[];
      note?: string;
      expectedContains?: string;
    }) {
      if (!input.runId && !input.workflowExecutionId) {
        throw new ValidationError("Either runId or workflowExecutionId is required");
      }

      let targetKind: "skill" | "workflow" | "agent" = "agent";
      let targetRef = "front";
      let caseInput: string | Record<string, unknown> = "";
      const graders: GraderSpec[] = [];

      if (input.workflowExecutionId) {
        const wfRow = db
          .query(
            `SELECT workflow_id AS workflowId, input, status, exit
               FROM workflow_execution
              WHERE execution_id = ?`,
          )
          .get(input.workflowExecutionId) as {
          workflowId: string;
          input: string;
          status: string;
          exit: string | null;
        } | null;
        if (!wfRow) throw new NotFoundError("WorkflowExecution", input.workflowExecutionId);
        targetKind = "workflow";
        targetRef = wfRow.workflowId;
        try {
          caseInput = JSON.parse(wfRow.input) as Record<string, unknown>;
        } catch {
          caseInput = {};
        }
        graders.push({
          type: "workflow_outcome",
          expectedStatus: "success",
          ...(wfRow.exit ? { expectedExit: wfRow.exit } : {}),
          forbidBudgetExhausted: true,
        });
      } else if (input.runId) {
        const runRow = db
          .query(
            `SELECT run_id AS runId, agent_id AS agentId, conversation_id AS conversationId
               FROM agent_run
              WHERE run_id = ?`,
          )
          .get(input.runId) as {
          runId: string;
          agentId: string;
          conversationId: string;
        } | null;
        if (!runRow) throw new NotFoundError("AgentRun", input.runId);
        targetRef = runRow.agentId;

        // Pull the most recent user message from the run's conversation ledger.
        const msgRow = db
          .query(
            `SELECT content FROM conversation_ledger
              WHERE conversation_id = ? AND kind = 'user'
              ORDER BY seq DESC LIMIT 1`,
          )
          .get(runRow.conversationId) as { content: string } | null;
        if (msgRow?.content) {
          try {
            const parsed = JSON.parse(msgRow.content) as { text?: string };
            caseInput = parsed.text?.trim() || msgRow.content;
          } catch {
            caseInput = msgRow.content;
          }
        }
        if (!caseInput) caseInput = `Replay run ${input.runId}`;

        // Check if any skill was activated in this run.
        const skillRow = db
          .query(
            `SELECT json_extract(data, '$.skillName') AS skillName
               FROM agent_run_event
              WHERE run_id = ? AND type = 'skill_activated'
              LIMIT 1`,
          )
          .get(input.runId) as { skillName: string | null } | null;
        if (skillRow?.skillName) {
          targetKind = "skill";
          targetRef = skillRow.skillName;
          graders.push({
            type: "skill_activated",
            skillName: skillRow.skillName,
            expected: true,
          });
        }
        if (input.expectedContains?.trim()) {
          graders.push({
            type: "output_match",
            contains: [input.expectedContains.trim()],
          });
        }
        if (graders.length === 0) {
          graders.push({
            type: "output_match",
            notContains: ["Internal server error"],
          });
        }
      }

      const existing = suiteStore.readParsed(input.suiteId);
      const caseId =
        input.caseId?.trim() ||
        `case-${(input.runId ?? input.workflowExecutionId ?? ulid()).slice(0, 8)}`;
      const newCase: EvalCase = {
        id: caseId,
        name:
          input.caseName?.trim() ||
          `Promoted from ${(input.runId ?? input.workflowExecutionId ?? "").slice(0, 10)}`,
        tags: [...(input.tags ?? []), "promoted"],
        input: caseInput,
        graders,
        budget: { maxDurationMs: 120_000, maxToolCalls: 20 },
      };

      const nextSuite: EvalSuite = existing
        ? {
            ...existing,
            cases: [...existing.cases.filter((c) => c.id !== caseId), newCase],
          }
        : {
            id: input.suiteId,
            name: input.suiteName?.trim() || input.suiteId,
            description: `Regression suite created from production telemetry`,
            target: { kind: targetKind, ref: targetRef },
            defaultTrials: 1,
            budget: { concurrency: 2 },
            cases: [newCase],
          };

      const saved = suiteStore.write(input.suiteId, nextSuite, {
        author: "user",
        summary: `Promote ${input.runId ?? input.workflowExecutionId} to ${input.suiteId}/${caseId}`,
      });

      const feedback = sqliteStore.saveFeedback({
        feedbackId: ulid(),
        runId: input.runId ?? null,
        workflowExecutionId: input.workflowExecutionId ?? null,
        rating: "down",
        tags: input.tags ?? ["regression"],
        note: input.note ?? null,
        promotedSuiteId: input.suiteId,
        promotedCaseId: caseId,
      });

      return { suite: saved.suite, commit: saved.commit, case: newCase, feedback };
    },
  };
}

export type EvalService = ReturnType<typeof createEvalService>;
