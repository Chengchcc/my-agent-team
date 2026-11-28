import type { ModelCost } from "@chengchenccc/ai";

export interface TokenUsageLike {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

/** Calculate estimated USD spend from token counts and per-1M-token model pricing. */
export function calculateUsageCostUsd(
  usage: TokenUsageLike | undefined,
  cost: ModelCost | undefined,
): number {
  if (!usage || !cost) return 0;
  const n = (v: number | undefined): number => (typeof v === "number" && v > 0 ? v : 0);
  return (
    (n(usage.inputTokens) * n(cost.input) +
      n(usage.outputTokens) * n(cost.output) +
      n(usage.cacheReadTokens) * n(cost.cacheRead) +
      n(usage.cacheWriteTokens) * n(cost.cacheWrite)) /
    1_000_000
  );
}

/** Compact human-readable USD string for status bar and /cost summaries. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
