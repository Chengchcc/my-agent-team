import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "./adapter-sqlite.harness.js";
import {
  createBudgetGate,
  DAILY_BUDGET_SETTING_KEY,
  DailyBudgetExhaustedError,
} from "./budget-gate.js";

// This suite exercises the pricing SUM, not referential integrity: the run
// rows stand alone, so the parent conversation/branch rows stay uncreated.
db.exec("PRAGMA foreign_keys = OFF");

/** Catalog prices are per million tokens; 1 in + 1 out makes the arithmetic
 *  readable (2_000_000 tokens in => $2). */
const costs = new Map([
  ["oma/deepseek/deepseek-flash", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }],
]);

function insertRun(id: string, inputTokens: number, outputTokens: number, createdAt: number): void {
  db.query(
    `INSERT INTO agent_run (run_id, branch_id, conversation_id, agent_id, model_ref, status,
                            idempotency_key, terminal_result, config_revision, created_at, terminal_at)
     VALUES (?, 'b1', 'c1', 'a1', ?, 'completed', ?, ?, 1, ?, ?)`,
  ).run(
    id,
    JSON.stringify({ backendKind: "oma", modelId: "deepseek/deepseek-flash" }),
    `k-${id}`,
    JSON.stringify({ status: "completed", usage: { inputTokens, outputTokens } }),
    createdAt,
    createdAt,
  );
}

function gateWith(cap: unknown) {
  return createBudgetGate({
    db,
    modelCosts: Promise.resolve(costs),
    getSetting: (key) => (key === DAILY_BUDGET_SETTING_KEY ? cap : undefined),
    now: () => new Date(),
  });
}

describe("daily budget gate", () => {
  // The harness db is one in-memory database shared by the whole file: each
  // case starts from a clean spend table or they price each other's runs.
  beforeEach(() => {
    db.exec("DELETE FROM agent_run");
  });

  test("no cap configured means no brake, and the status says so", async () => {
    insertRun("budget-none", 1_000_000, 0, Date.now());
    const gate = gateWith(undefined);
    await expect(gate.assertWithinDailyBudget()).resolves.toBeUndefined();
    const status = await gate.dailyStatus();
    expect(status.capUsd).toBeNull();
    expect(status.spentUsd).toBeCloseTo(1, 5);
  });

  test("spend at the cap refuses the next run and names the cap", async () => {
    insertRun("budget-over", 3_000_000, 0, Date.now());
    const gate = gateWith(2);
    const err = await gate.assertWithinDailyBudget().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DailyBudgetExhaustedError);
    expect(String(err)).toContain("daily budget exhausted");
    expect(String(err)).toContain(DAILY_BUDGET_SETTING_KEY);
  });

  test("a numeric string cap (how settings round-trip) is honoured", async () => {
    insertRun("budget-string", 4_000_000, 0, Date.now());
    const gate = gateWith("2.5");
    await expect(gate.assertWithinDailyBudget()).rejects.toBeInstanceOf(DailyBudgetExhaustedError);
  });

  test("yesterday's spend does not count against today", async () => {
    const yesterday = Date.now() - 26 * 60 * 60 * 1000;
    insertRun("budget-yesterday", 9_000_000, 0, yesterday);
    const gate = gateWith(1);
    await expect(gate.assertWithinDailyBudget()).resolves.toBeUndefined();
  });

  test("a garbage cap is treated as no cap, never as zero", async () => {
    insertRun("budget-garbage", 1_000_000, 0, Date.now());
    const gate = gateWith("not-a-number");
    await expect(gate.assertWithinDailyBudget()).resolves.toBeUndefined();
  });
});
