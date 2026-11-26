/** Numbers as the ops pages write them: short, mono, no false precision. */
import { formatDurationMs } from "@/lib/duration";
import { t } from "@/lib/i18n";

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}G`;
}

/** How long ago a moment was, in a person's words. */
export function fmtAgo(at: number | null, now: number): string {
  if (at === null) return t("never");
  const elapsed = Math.max(0, now - at);
  return formatDurationMs(elapsed);
}

/** A run's tokens and cost, or a dash when it reported neither. */
export function fmtUsage(
  usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | null,
): string {
  if (usage === null) return "—";
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  if (usage.costUsd === undefined) return `${fmtTokens(tokens)} tok`;
  return `${fmtTokens(tokens)} tok · $${usage.costUsd.toFixed(4)}`;
}
