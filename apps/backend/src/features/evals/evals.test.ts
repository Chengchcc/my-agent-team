import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../infra/sqlite/db.js";
import { EvalSqliteStore } from "./adapter-sqlite.js";
import { type EvalSuite, parseEvalSuite } from "./domain.js";
import { gradeEvalTrial } from "./graders.js";
import { createEvalService } from "./service.js";
import { createFsEvalSuiteStore } from "./suite-store.js";

describe("ADR 0085 Evals & Feedback", () => {
  let db: Database;
  let tmpDir: string;
  let suiteDir: string;

  beforeEach(() => {
    db = openDb(":memory:");
    db.exec("PRAGMA foreign_keys = OFF");
    tmpDir = mkdtempSync(join(tmpdir(), "evals-test-"));
    suiteDir = join(tmpDir, "evals");
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("FsEvalSuiteStore writes atomically with Git history and supports revert", () => {
    const store = createFsEvalSuiteStore(suiteDir);
    const v1: EvalSuite = parseEvalSuite({
      id: "skill-refactor",
      name: "Refactor Skill v1",
      target: { kind: "skill", ref: "refactor" },
      cases: [
        {
          id: "c1",
          name: "Extract helper",
          input: "refactor foo.ts",
          graders: [{ type: "skill_activated", skillName: "refactor" }],
        },
      ],
    });
    const r1 = store.write("skill-refactor", v1, { author: "alice", summary: "Initial v1" });
    expect(r1.suite.name).toBe("Refactor Skill v1");
    expect(store.readParsed("skill-refactor")?.cases).toHaveLength(1);

    const v2 = { ...v1, name: "Refactor Skill v2" };
    const r2 = store.write("skill-refactor", v2, { author: "bob", summary: "Rename to v2" });
    expect(r2.suite.name).toBe("Refactor Skill v2");

    if (store.gitReady && r1.commit) {
      const hist = store.history("skill-refactor");
      expect(hist.length).toBeGreaterThanOrEqual(2);
      const reverted = store.revert("skill-refactor", r1.commit, {
        author: "alice",
        summary: "Revert to v1",
      });
      expect(reverted.suite.name).toBe("Refactor Skill v1");
    }
  });

  test("gradeEvalTrial evaluates deterministic contracts, trajectory budgets, anti-spinning, and optional LLM judge", async () => {
    const evalCase = parseEvalSuite({
      id: "s1",
      name: "Suite",
      target: { kind: "skill", ref: "workflow_design" },
      cases: [
        {
          id: "c1",
          name: "Design workflow",
          input: "create a daily report workflow",
          graders: [
            { type: "skill_activated", skillName: "workflow_design" },
            { type: "tool_called", toolName: "workflow_save", argsMatch: "daily" },
            { type: "tool_forbidden", toolName: "bash" },
            { type: "output_match", contains: ["saved"], regex: "daily.*report" },
            { type: "llm_judge", rubric: "Clear summary", minScore: 4 },
          ],
          budget: { maxDurationMs: 10_000, maxToolCalls: 5, maxCostUsd: 0.05 },
        },
      ],
    }).cases[0]!;

    const ok = await gradeEvalTrial(
      evalCase,
      {
        input: evalCase.input,
        outputText: "The daily report workflow was saved.",
        status: "completed",
        error: null,
        activeDurationMs: 3200,
        toolCalls: 2,
        inputTokens: 500,
        outputTokens: 80,
        cacheReadTokens: 200,
        costUsd: 0.01,
        skillsActivated: ["workflow_design"],
        tools: [{ toolName: "workflow_save", inputText: '{"id":"daily"}', isError: false }],
      },
      { judge: async () => ({ pass: true, score: 5, reason: "Crisp and accurate" }) },
    );
    expect(ok.passed).toBe(true);
    expect(ok.score).toBe(1);

    // Violate tool_forbidden + budget_tools + budget_cost
    const fail = await gradeEvalTrial(
      evalCase,
      {
        input: evalCase.input,
        outputText: "The daily report workflow was saved.",
        status: "completed",
        error: null,
        activeDurationMs: 3200,
        toolCalls: 7,
        inputTokens: 500,
        outputTokens: 80,
        cacheReadTokens: 0,
        costUsd: 0.12,
        skillsActivated: ["workflow_design"],
        tools: [
          { toolName: "workflow_save", inputText: '{"id":"daily"}', isError: false },
          { toolName: "bash", inputText: "rm -rf", isError: false },
        ],
      },
      { judge: async () => ({ pass: true, score: 5, reason: "ok" }) },
    );
    expect(fail.passed).toBe(false);
    expect(fail.graderResults.filter((g) => !g.passed).map((g) => g.type)).toEqual([
      "tool_forbidden",
      "budget_tools",
      "budget_cost",
    ]);
  });

  test("EvalService computes pass@k / pass^k, stops on budget cap, supports rerunFailedFrom, and diffs Baseline vs Candidate", async () => {
    const suiteStore = createFsEvalSuiteStore(suiteDir);
    const sqliteStore = new EvalSqliteStore(db);
    let seq = 0;
    const ulid = () => `id-${++seq}`;

    let mode: "baseline" | "candidate" = "baseline";
    let trialCounter = 0;

    const svc = createEvalService({
      db,
      suiteStore,
      sqliteStore,
      ulid,
      execution: {
        runAgentCase: async ({ evalCase, trialIndex }) => {
          trialCounter++;
          // Baseline: c1 passes all trials, c2 passes trial 0 and fails trial 1 (pass@2=1, pass^2=0)
          // Candidate: c1 regresses (fails), c2 improves (passes all)
          const ok =
            mode === "baseline" ? evalCase.id === "c1" || trialIndex === 0 : evalCase.id === "c2";
          return {
            runId: `run-${mode}-${evalCase.id}-${trialIndex}`,
            observation: {
              input: evalCase.input,
              outputText: ok ? "OK_ANSWER" : "WRONG",
              status: "completed",
              error: null,
              activeDurationMs: 1000,
              toolCalls: 1,
              inputTokens: 100,
              outputTokens: 50,
              cacheReadTokens: 100,
              costUsd: 0.02,
              skillsActivated: [],
              tools: [],
            },
          };
        },
        runWorkflowCase: async () => {
          throw new Error("not used");
        },
      },
    });

    svc.saveSuite("agent-suite", {
      id: "agent-suite",
      name: "Agent Suite",
      target: { kind: "agent", ref: "front" },
      cases: [
        {
          id: "c1",
          name: "Case 1",
          input: "q1",
          graders: [{ type: "output_match", contains: ["OK_ANSWER"] }],
        },
        {
          id: "c2",
          name: "Case 2",
          input: "q2",
          graders: [{ type: "output_match", contains: ["OK_ANSWER"] }],
        },
      ],
    });

    const baseline = await svc.startEvalRun("agent-suite", {
      label: "baseline",
      trials: 2,
      wait: true,
    });
    expect(baseline.status).toBe("completed");
    expect(baseline.summary?.passAtK).toBe(1);
    expect(baseline.summary?.passPowK).toBe(0.5); // c1 all passed, c2 split 1/2
    expect(baseline.summary?.cacheHitRate).toBeCloseTo(0.5);

    mode = "candidate";
    const candidate = await svc.startEvalRun("agent-suite", {
      label: "candidate",
      trials: 2,
      wait: true,
    });
    const diff = svc.diffRuns(baseline.evalRunId, candidate.evalRunId);
    expect(diff.regressions).toBe(1);
    expect(diff.improvements).toBe(1);
    expect(diff.cases[0]?.caseId).toBe("c1");
    expect(diff.cases[0]?.change).toBe("regressed");
    expect(diff.cases[1]?.caseId).toBe("c2");
    expect(diff.cases[1]?.change).toBe("improved");

    // Rerun failed from candidate -> only runs c1
    const rerun = await svc.startEvalRun("agent-suite", {
      rerunFailedFrom: candidate.evalRunId,
      trials: 1,
      wait: true,
    });
    expect(rerun.summary?.totalCases).toBe(1);

    // Budget cap fuse stops after spending $0.02 when cap is $0.015
    const capped = await svc.startEvalRun("agent-suite", {
      trials: 2,
      concurrency: 1,
      maxTotalCostUsd: 0.015,
      wait: true,
    });
    expect(capped.status).toBe("budget_stopped");
    expect(capped.summary?.totalTrials).toBe(1);
    expect(trialCounter).toBeGreaterThan(0);
  });

  test("promoteToEvalCase turns a production run with skill_activated into a Git-committed EvalCase and records feedback", () => {
    const suiteStore = createFsEvalSuiteStore(suiteDir);
    const sqliteStore = new EvalSqliteStore(db);
    let seq = 0;
    const svc = createEvalService({
      db,
      suiteStore,
      sqliteStore,
      ulid: () => `fb-${++seq}`,
      execution: {
        runAgentCase: async () => {
          throw new Error("unused");
        },
        runWorkflowCase: async () => {
          throw new Error("unused");
        },
      },
    });

    const now = Date.now();
    db.query(
      `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, created_at)
       VALUES ('run-prod-1', 'b1', 'conv-1', 'coder', '{}', 'failed', 'k1', 1, ?)`,
    ).run(now);
    db.query(
      `INSERT INTO conversation_ledger (conversation_id, kind, content, ts)
       VALUES ('conv-1', 'user', ?, ?)`,
    ).run(JSON.stringify({ text: "Refactor auth middleware safely" }), now);
    db.query(
      `INSERT INTO agent_run_event (run_id, type, data, ts)
       VALUES ('run-prod-1', 'skill_activated', ?, ?)`,
    ).run(JSON.stringify({ skillName: "refactor", path: "/skills/refactor/SKILL.md" }), now);

    const promoted = svc.promoteToEvalCase({
      runId: "run-prod-1",
      suiteId: "prod-regressions",
      caseName: "Auth middleware refactor",
      expectedContains: "middleware",
    });

    expect(promoted.suite.target).toEqual({ kind: "skill", ref: "refactor" });
    expect(promoted.case.input).toBe("Refactor auth middleware safely");
    expect(promoted.case.graders.map((g) => g.type)).toEqual(["skill_activated", "output_match"]);
    expect(promoted.feedback.promotedSuiteId).toBe("prod-regressions");
    expect(svc.listFeedback({ runId: "run-prod-1" })).toHaveLength(1);
  });
});
