import type { Database } from "bun:sqlite";
import { resolveModelAlias } from "@chengchenccc/ai";

/** The daily spend cap (USD). A missing/zero/negative value means no cap —
 *  the product default stays open, and the brake is opt-in like H2's script
 *  nodes: unattended automation (a cron workflow spawning runs) is exactly
 *  who this is for, and nobody should wake up to a surprise bill because a
 *  solver retried all night. */
export const DAILY_BUDGET_SETTING_KEY = "cost.dailyBudgetUsd";

/** Why a run refused to start. Carried in the run's terminal error so the
 *  surface (card, web, workflow node) can say it plainly. */
export class DailyBudgetExhaustedError extends Error {
  constructor(spentUsd: number, capUsd: number) {
    super(
      `daily budget exhausted: $${spentUsd.toFixed(2)} of the $${capUsd.toFixed(2)} cap ` +
        `(settings ${DAILY_BUDGET_SETTING_KEY}); no new runs start until the day rolls over or the cap is raised`,
    );
    this.name = "DailyBudgetExhaustedError";
  }
}

export interface BudgetGateDeps {
  readonly db: Database;
  /** modelId → per-Mtok USD, the same snapshot /api/usage/summary prices with. */
  readonly modelCosts: Promise<
    Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>
  >;
  /** The settings service returns PARSED JSON, so a cap may arrive as a number
   *  or a numeric string depending on how it was set. */
  readonly getSetting: (key: string) => unknown;
  /** Injectable so a test can pin "today" without waiting for midnight. */
  readonly now?: () => Date;
}

export interface BudgetGate {
  /** Throws DailyBudgetExhaustedError when today's catalog-priced spend has
   *  reached the cap. Everything else (no cap, no priced runs, a failed
   *  price lookup) passes: the gate must never be why a legit run cannot
   *  start, only why spending more cannot. */
  assertWithinDailyBudget(): Promise<void>;
  /** Today's numbers for the surfaces: what was spent and against what. */
  dailyStatus(): Promise<{ spentUsd: number; capUsd: number | null }>;
}

export function createBudgetGate(deps: BudgetGateDeps): BudgetGate {
  async function todaySpendUsd(): Promise<number> {
    const startOfDay = deps.now?.() ?? new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const groups = deps.db
      .query(
        `SELECT ar.model_ref,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.inputTokens') AS REAL)), 0) AS inputTokens,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.outputTokens') AS REAL)), 0) AS outputTokens,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.cacheReadTokens') AS REAL)), 0) AS cacheReadTokens,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.cacheWriteTokens') AS REAL)), 0) AS cacheWriteTokens,
                COALESCE(SUM(CAST(json_extract(ar.terminal_result, '$.usage.costUsd') AS REAL)), 0) AS reportedCostUsd
           FROM agent_run ar
          WHERE ar.terminal_result IS NOT NULL AND ar.created_at >= ?
          GROUP BY ar.model_ref`,
      )
      .all(startOfDay.getTime()) as Array<{
      model_ref: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      reportedCostUsd: number;
    }>;
    const costs = await deps.modelCosts;
    let spent = 0;
    for (const g of groups) {
      const ref = JSON.parse(g.model_ref) as { backendKind: string; modelId: string };
      const c = costs.get(`${ref.backendKind}/${resolveModelAlias(ref.modelId)}`);
      spent += c
        ? (g.inputTokens * c.input +
            g.outputTokens * c.output +
            g.cacheReadTokens * c.cacheRead +
            g.cacheWriteTokens * c.cacheWrite) /
          1_000_000
        : g.reportedCostUsd;
    }
    return spent;
  }

  function capUsd(): number | null {
    const raw = deps.getSetting(DAILY_BUDGET_SETTING_KEY);
    if (raw === undefined || raw === null) return null;
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  }

  return {
    async assertWithinDailyBudget() {
      const cap = capUsd();
      if (cap === null) return;
      const spent = await todaySpendUsd();
      if (spent >= cap) throw new DailyBudgetExhaustedError(spent, cap);
    },
    async dailyStatus() {
      const cap = capUsd();
      return { spentUsd: await todaySpendUsd(), capUsd: cap };
    },
  };
}
