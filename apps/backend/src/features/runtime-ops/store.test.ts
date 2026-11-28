import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { RuntimeOpsStore } from "./store.js";

function createTestDb() {
  return openDb(":memory:");
}

describe("RuntimeOpsStore", () => {
  let db: Database;
  let store: RuntimeOpsStore;

  beforeEach(() => {
    db = createTestDb();
    store = new RuntimeOpsStore(db);
  });

  afterEach(() => db.close());

  describe("surface_health", () => {
    test("a flat number the bot reports survives as a payload scalar", () => {
      // The join the Lark surface view depends on: the bot posts
      // `pendingDeliveries` as a top-level number, the runtime flattener
      // lifts top-level numbers into counters, and the view reads
      // `counters.pendingDeliveries`. A nested object would never appear,
      // so this value's SHAPE is part of the contract.
      store.upsertSurfaceHealth({
        agentId: "agent_lark",
        surface: "lark",
        status: "running",
        payload: { profileRef: "agent:1", pendingDeliveries: 4 },
      });
      const health = store.getSurfaceHealth("agent_lark", "lark");
      expect(health?.payload).toMatchObject({ pendingDeliveries: 4 });
    });
    test("upsert and get", () => {
      store.upsertSurfaceHealth({
        agentId: "agent_x",
        surface: "lark",
        status: "running",
        payload: { watchers: { conversation: 3 } },
      });

      const health = store.getSurfaceHealth("agent_x", "lark");
      expect(health).toBeDefined();
      expect(health!.status).toBe("running");
    });

    test("getSurfaceHealthsForAgent", () => {
      store.upsertSurfaceHealth({
        agentId: "agent_x",
        surface: "lark",
        status: "running",
        payload: {},
      });

      expect(store.getSurfaceHealthsForAgent("agent_x")).toHaveLength(1);
    });

    test("upsertSurfaceHealth updates existing", () => {
      store.upsertSurfaceHealth({
        agentId: "agent_x",
        surface: "lark",
        status: "running",
        payload: {},
      });
      store.upsertSurfaceHealth({
        agentId: "agent_x",
        surface: "lark",
        status: "degraded",
        payload: { error: "card failed" },
        lastError: "card update failed",
      });

      const health = store.getSurfaceHealth("agent_x", "lark");
      expect(health!.status).toBe("degraded");
      expect(health!.lastError).toBe("card update failed");
    });

    test("listSurfaceHealths orders by agentId then surface", () => {
      store.upsertSurfaceHealth({ agentId: "b", surface: "lark", status: "ok", payload: {} });
      store.upsertSurfaceHealth({ agentId: "a", surface: "lark", status: "ok", payload: {} });
      store.upsertSurfaceHealth({ agentId: "a", surface: "web", status: "ok", payload: {} });

      const rows = store.listSurfaceHealths();
      expect(rows.map((r) => `${r.agentId}/${r.surface}`)).toEqual(["a/lark", "a/web", "b/lark"]);
    });
  });

  describe("agent_run_event / telemetry", () => {
    beforeEach(() => {
      // These tests insert agent_run rows directly; the FK chain (member ->
      // tree -> branch -> run) is out of scope for store unit tests.
      db.exec("PRAGMA foreign_keys = OFF");
    });

    afterEach(() => db.exec("PRAGMA foreign_keys = ON"));

    test("appendRunEvent + listRunEvents round-trip", () => {
      store.appendRunEvent("r1", "native_tool_started", { toolName: "bash" });
      store.appendRunEvent("r1", "status", { status: "completed" });

      const events = store.listRunEvents("r1");
      expect(events).toHaveLength(2);
      expect(events[0]!.type).toBe("native_tool_started");
      expect(events[0]!.data).toEqual({ toolName: "bash" });
      expect(events[0]!.ts).toBeGreaterThan(0);
    });

    test("telemetrySummary aggregates runs, usage and tool calls", () => {
      const now = Date.now();
      db.query(
        `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, terminal_result, created_at, terminal_at)
         VALUES (?, 'b1', 'c1', 'm1', ?, 'completed', 'k1', 1, ?, ?, ?)`,
      ).run(
        "r-agg",
        JSON.stringify({ backendKind: "oma", modelId: "fake/m" }),
        JSON.stringify({
          status: "completed",
          usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
        }),
        now - 5_000,
        now,
      );
      store.appendRunEvent("r-agg", "native_tool_started", { toolName: "bash" });
      store.appendRunEvent("r-agg", "native_tool_started", { toolName: "grep" });
      store.appendRunEvent("r-agg", "text_delta", { text: "ignored" }); // not counted

      const summary = store.telemetrySummary(now - 60_000);
      expect(summary.runs).toBe(1);
      expect(summary.inputTokens).toBe(100);
      expect(summary.outputTokens).toBe(50);
      expect(summary.costUsd).toBeCloseTo(0.01);
      expect(summary.toolCalls).toBe(2); // text_delta not counted
      expect(summary.avgDurationMs).toBe(5000);
      expect(summary.recent).toHaveLength(1);
      expect(summary.recent[0]!.modelId).toBe("fake/m");
      expect(summary.recent[0]!.toolCalls).toBe(2);
      expect(summary.recent[0]!.durationMs).toBe(5000);
    });

    test("telemetrySummary respects the since window", () => {
      const now = Date.now();
      db.query(
        `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, created_at)
         VALUES (?, 'b2', 'c2', 'm2', ?, 'completed', 'k2', 1, ?)`,
      ).run("old", JSON.stringify({ backendKind: "oma", modelId: "fake/m" }), now - 86_400_000 * 2);

      const summary = store.telemetrySummary(now - 86_400_000);
      expect(summary.runs).toBe(0);
    });
    test("telemetrySummary includes byAgent success rate and failure errors", () => {
      const now = Date.now();
      db.query(
        `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, terminal_result, created_at, terminal_at)
         VALUES (?, 'b1', 'c1', 'a1', ?, 'completed', 'k3', 1, ?, ?, ?)`,
      ).run(
        "r-ok",
        JSON.stringify({ backendKind: "oma", modelId: "fake/m" }),
        JSON.stringify({
          status: "completed",
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
        }),
        now - 5_000,
        now,
      );
      db.query(
        `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, terminal_result, created_at, terminal_at)
         VALUES (?, 'b2', 'c2', 'a1', ?, 'failed', 'k4', 1, ?, ?, ?)`,
      ).run(
        "r-fail",
        JSON.stringify({ backendKind: "oma", modelId: "fake/m" }),
        JSON.stringify({
          status: "failed",
          error: "model timeout",
          usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.001 },
        }),
        now - 3_000,
        now,
      );

      const summary = store.telemetrySummary(now - 60_000);
      expect(summary.byAgent).toHaveLength(1);
      expect(summary.byAgent[0]).toMatchObject({
        agentId: "a1",
        runs: 2,
        completed: 1,
        failed: 1,
      });
      expect(summary.byAgent[0]!.successRate).toBeCloseTo(0.5);
      expect(summary.failures).toHaveLength(1);
      expect(summary.failures[0]).toMatchObject({
        runId: "r-fail",
        status: "failed",
        error: "model timeout",
        agentId: "a1",
      });
      expect(summary.costByHour).toHaveLength(1);
      expect(summary.costByHour[0]!.costUsd).toBeCloseTo(0.002);
      expect(summary.costByHour[0]!.tokens).toBe(25);
      expect(summary.byModel).toHaveLength(1);
      expect(summary.byModel[0]).toMatchObject({
        modelId: "fake/m",
        runs: 2,
        completed: 1,
        failed: 1,
      });
      expect(summary.byModel[0]!.costUsd).toBeCloseTo(0.002);
      expect(summary.byModel[0]!.tokens).toBe(25);
      expect(summary.successRateByDay).toHaveLength(1);
      expect(summary.successRateByDay[0]!.runs).toBe(2);
      expect(summary.successRateByDay[0]!.completed).toBe(1);
      expect(summary.successRateByDay[0]!.failed).toBe(1);
      expect(summary.successRateByDay[0]!.successRate).toBeCloseTo(0.5);
      expect(summary.durationByDay).toHaveLength(1);
      expect(summary.durationByDay[0]!.runs).toBe(2);
      expect(summary.durationByDay[0]!.avgDurationMs).toBeCloseTo(4000);
      expect(summary.failureCauses).toHaveLength(1);
      expect(summary.failureCauses[0]).toEqual({ cause: "timeout", count: 1 });
    });
    test("telemetrySummary flags spinning runs", () => {
      const now = Date.now();
      db.query(
        `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, idempotency_key, config_revision, terminal_result, created_at, terminal_at)
         VALUES (?, 'bsp', 'csp', 'asp', ?, 'completed', 'ksp', 1, ?, ?, ?)`,
      ).run(
        "r-spin",
        JSON.stringify({ backendKind: "oma", modelId: "fake/m" }),
        JSON.stringify({
          status: "completed",
          usage: { inputTokens: 20, outputTokens: 0, costUsd: 0.01 },
        }),
        now - 120_000,
        now,
      );
      for (let i = 0; i < 8; i += 1) {
        store.appendRunEvent("r-spin", "native_tool_started", { toolName: "bash" });
      }

      const summary = store.telemetrySummary(now - 600_000);
      expect(summary.spinningRuns).toHaveLength(1);
      expect(summary.spinningRuns[0]).toMatchObject({
        runId: "r-spin",
        toolCalls: 8,
        durationMs: 120_000,
      });
    });

    test("ADR 0085: aggregates cacheHitRate, active duration (stripping HITL wait), TTFT, toolStats, skillStats, qualitySignals, and scope isolation", () => {
      const now = Date.now();
      // Production run with 10s wall time, 6s pending_action wait => 4s active duration, 75% cache hit
      db.query(
        `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, authorization, idempotency_key, config_revision, terminal_result, created_at, terminal_at)
         VALUES (?, 'b1', 'c1', 'a1', ?, 'completed', 'user', 'kp1', 1, ?, ?, ?)`,
      ).run(
        "r-prod",
        JSON.stringify({ backendKind: "oma", modelId: "anthropic/sonnet" }),
        JSON.stringify({
          status: "completed",
          usage: {
            inputTokens: 1000,
            outputTokens: 200,
            cacheReadTokens: 3000,
            cacheWriteTokens: 500,
            costUsd: 0.02,
          },
        }),
        now - 10_000,
        now,
      );
      db.query(
        `INSERT INTO pending_action (action_id, run_id, kind, payload, status, created_at, resolved_at, owner)
         VALUES ('act-1', 'r-prod', 'approval', '{}', 'resolved', ?, ?, 'user')`,
      ).run(now - 8_000, now - 2_000);
      db.query(`INSERT INTO agent_run_event (run_id, type, data, ts) VALUES (?, ?, ?, ?)`).run(
        "r-prod",
        "llm_turn_started",
        JSON.stringify({ turn: 0, ttftMs: 420 }),
        now - 9_500,
      );
      db.query(`INSERT INTO agent_run_event (run_id, type, data, ts) VALUES (?, ?, ?, ?)`).run(
        "r-prod",
        "native_tool_started",
        JSON.stringify({ toolName: "bash", callId: "c1" }),
        now - 9_000,
      );
      db.query(`INSERT INTO agent_run_event (run_id, type, data, ts) VALUES (?, ?, ?, ?)`).run(
        "r-prod",
        "native_tool_completed",
        JSON.stringify({ toolName: "bash", callId: "c1", result: { isError: true } }),
        now - 8_200,
      );
      db.query(`INSERT INTO agent_run_event (run_id, type, data, ts) VALUES (?, ?, ?, ?)`).run(
        "r-prod",
        "skill_activated",
        JSON.stringify({ skillName: "workflow_design", path: "/skills/workflow_design/SKILL.md" }),
        now - 8_500,
      );
      db.query(`INSERT INTO agent_run_event (run_id, type, data, ts) VALUES (?, ?, ?, ?)`).run(
        "r-prod",
        "unasked_question",
        JSON.stringify({}),
        now - 1_000,
      );

      // Eval run that MUST be excluded from default scope="production"
      db.query(
        `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status, authorization, idempotency_key, config_revision, terminal_result, created_at, terminal_at)
         VALUES (?, 'b2', 'c2', 'a1', ?, 'failed', 'eval:ev1', 'ke1', 1, ?, ?, ?)`,
      ).run(
        "r-eval",
        JSON.stringify({ backendKind: "oma", modelId: "anthropic/sonnet" }),
        JSON.stringify({
          status: "failed",
          error: "eval fail",
          usage: { inputTokens: 500, outputTokens: 50 },
        }),
        now - 5_000,
        now,
      );

      const prod = store.telemetrySummary({ sinceMs: now - 60_000 });
      expect(prod.runs).toBe(1);
      expect(prod.cacheReadTokens).toBe(3000);
      expect(prod.cacheHitRate).toBeCloseTo(0.75);
      expect(prod.totalHumanWaitMs).toBe(6000);
      expect(prod.p50DurationMs).toBe(4000);
      expect(prod.p50TtftMs).toBe(420);
      expect(prod.toolStats[0]).toMatchObject({
        toolName: "bash",
        calls: 1,
        errors: 1,
        errorRate: 1,
        p50Ms: 800,
      });
      expect(prod.skillStats[0]).toMatchObject({
        skillName: "workflow_design",
        activations: 1,
        runs: 1,
        completed: 1,
      });
      expect(prod.qualitySignals).toMatchObject({ unaskedQuestion: 1, total: 1 });

      const evalOnly = store.telemetrySummary({ sinceMs: now - 60_000, scope: "eval" });
      expect(evalOnly.runs).toBe(1);
      expect(evalOnly.failures[0]?.runId).toBe("r-eval");

      const all = store.telemetrySummary({ sinceMs: now - 60_000, scope: "all" });
      expect(all.runs).toBe(2);
    });

    test("ADR 0085: getRunTrace builds recursive dispatch tree, wait intervals, redacted tool payloads, and prompt snapshot", () => {
      const now = Date.now();
      db.query(
        `INSERT INTO agent_run (run_id, parent_run_id, branch_id, conversation_id, agent_id, model_ref, status, system_prompt, skill_roots, idempotency_key, config_revision, terminal_result, created_at, terminal_at)
         VALUES ('r-root', NULL, 'b1', 'c1', 'front', ?, 'completed', 'FRONT PROMPT', '["/skills"]', 'kr1', 1, ?, ?, ?)`,
      ).run(
        JSON.stringify({ backendKind: "oma", modelId: "m1" }),
        JSON.stringify({ status: "completed", usage: { inputTokens: 10, outputTokens: 5 } }),
        now - 20_000,
        now,
      );
      db.query(
        `INSERT INTO agent_run (run_id, parent_run_id, branch_id, conversation_id, agent_id, model_ref, status, system_prompt, skill_roots, idempotency_key, config_revision, terminal_result, created_at, terminal_at)
         VALUES ('r-child', 'r-root', 'b2', 'c2', 'coder', ?, 'completed', 'CODER PROMPT', '["/skills"]', 'kr2', 1, ?, ?, ?)`,
      ).run(
        JSON.stringify({ backendKind: "oma", modelId: "m2" }),
        JSON.stringify({
          status: "completed",
          messages: [
            {
              role: "assistant",
              blocks: [
                {
                  type: "tool_use",
                  id: "tc-1",
                  name: "read",
                  input: { path: "/skills/refactor/SKILL.md", apiKey: "sk-secret-1234567890" },
                },
              ],
            },
            {
              role: "tool",
              blocks: [
                { type: "tool_result", tool_use_id: "tc-1", content: "Bearer abcdef1234567890" },
              ],
            },
          ],
        }),
        now - 15_000,
        now - 2_000,
      );

      const trace = store.getRunTrace("r-child");
      expect(trace).not.toBeNull();
      expect(trace!.rootRunId).toBe("r-root");
      expect(trace!.focusRunId).toBe("r-child");
      expect(trace!.tree.children).toHaveLength(1);
      expect(trace!.tree.children[0]!.runId).toBe("r-child");
      expect(trace!.systemPrompt).toBe("CODER PROMPT");
      expect(trace!.skillRoots).toEqual(["/skills"]);
      expect(trace!.skillsActivated).toEqual([
        { skillName: "refactor", path: "/skills/refactor/SKILL.md" },
      ]);
      expect(trace!.toolPayloads["tc-1"]?.input).toContain("[REDACTED]");
      expect(trace!.toolPayloads["tc-1"]?.input).not.toContain("sk-secret");
      expect(trace!.toolPayloads["tc-1"]?.output).toContain("[REDACTED]");
    });
  });
});
