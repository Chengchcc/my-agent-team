/** Shared HTTP query-parameter parsing helpers so list endpoints never pass
 *  NaN, negative numbers (SQLite `LIMIT -1` = unbounded full-table scan), or
 *  excessive limits into SQL queries. */
export function parseBoundedLimit(
  raw: string | number | undefined | null,
  defaultLimit: number,
  maxLimit: number,
): number {
  if (raw === undefined || raw === null || raw === "") return defaultLimit;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return defaultLimit;
  const floored = Math.floor(n);
  if (floored < 1) return defaultLimit;
  return Math.min(floored, maxLimit);
}

/** Non-negative integer offset parser; malformed or negative values fall back to 0. */
export function parseBoundedOffset(
  raw: string | number | undefined | null,
  maxOffset = 100_000,
): number {
  if (raw === undefined || raw === null || raw === "") return 0;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 0;
  const floored = Math.floor(n);
  if (floored < 0) return 0;
  return Math.min(floored, maxOffset);
}
