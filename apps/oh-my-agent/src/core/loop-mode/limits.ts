/** Loop-mode limits — the reference implementation's limits module, ported faithfully.
 *
 *  `/loop [count|duration] [prompt]`: a leading token that LOOKS like a limit
 *  (starts with a digit or sign) is parsed as one and a malformed one is a
 *  hard error; anything else is prose, i.e. the loop prompt — so
 *  `/loop keep going` starts an unbounded loop instead of erroring. */

export type LoopLimitConfig =
  | { kind: "iterations"; iterations: number }
  | { kind: "duration"; durationMs: number };

export type LoopLimitRuntime =
  | { kind: "iterations"; initial: number; remaining: number }
  | { kind: "duration"; durationMs: number; deadlineMs: number };

const TIME_UNITS_MS = new Map<string, number>([
  ["s", 1_000],
  ["sec", 1_000],
  ["secs", 1_000],
  ["second", 1_000],
  ["seconds", 1_000],
  ["m", 60_000],
  ["min", 60_000],
  ["mins", 60_000],
  ["minute", 60_000],
  ["minutes", 60_000],
  ["h", 3_600_000],
  ["hr", 3_600_000],
  ["hrs", 3_600_000],
  ["hour", 3_600_000],
  ["hours", 3_600_000],
]);

export const LOOP_USAGE =
  "usage: /loop [count|duration] [prompt] — examples: /loop, /loop 10, /loop 10m, /loop 1h30m keep going";

export interface ParsedLoopArgs {
  /** Iteration/duration budget from the leading limit token, when present. */
  limit?: LoopLimitConfig;
  /** Inline loop prompt: text after the limit, or the whole argument otherwise. */
  prompt?: string;
}

export function parseLoopArgs(args: string): ParsedLoopArgs | string {
  const trimmed = args.trim();
  if (!trimmed) return {};

  const firstSpace = trimmed.search(/\s/);
  const firstToken = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();
  const token = firstToken.toLowerCase();

  // Not a limit attempt (prose like "keep going") → unbounded loop, whole args
  // are the prompt.
  if (!/^[+-]?\d/.test(token)) return { prompt: trimmed };

  // Bare integer: iteration count, unless the next token is a time unit
  // ("10 minutes").
  if (/^\d+$/.test(token)) {
    if (rest) {
      const restTokens = rest.split(/\s+/);
      const unitMs = TIME_UNITS_MS.get(restTokens[0]!.toLowerCase());
      if (unitMs !== undefined) {
        const limit = makeDuration(token, unitMs);
        if (typeof limit === "string") return limit;
        return { limit, prompt: restTokens.slice(1).join(" ").trim() || undefined };
      }
    }
    const limit = makeIterations(token);
    if (typeof limit === "string") return limit;
    return { limit, prompt: rest || undefined };
  }

  // Compact / compound duration: "10m", "90s", "1h30m".
  const duration = parseCompoundDuration(token);
  if (duration !== undefined) {
    if (typeof duration === "string") return duration;
    return { limit: duration, prompt: rest || undefined };
  }

  // Limit-shaped but unparseable ("-1", "1.5h", "10x10").
  return LOOP_USAGE;
}

function makeIterations(amountText: string): LoopLimitConfig | string {
  const amount = Number(amountText);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return "loop count must be a positive integer";
  }
  return { kind: "iterations", iterations: amount };
}

function makeDuration(amountText: string, unitMs: number): LoopLimitConfig | string {
  const amount = Number(amountText);
  if (!Number.isSafeInteger(amount) || amount <= 0) return "loop duration must be positive";
  return { kind: "duration", durationMs: amount * unitMs };
}

/** `10m`, `90s`, `1h30m`. Undefined when the token is not duration-shaped; an
 *  error string when it is shaped like one but uses an unknown unit. */
function parseCompoundDuration(token: string): LoopLimitConfig | string | undefined {
  if (!/^(?:\d+[a-z]+)+$/.test(token)) return undefined;
  const segments = token.match(/\d+[a-z]+/g);
  if (!segments) return undefined;
  let totalMs = 0;
  for (const segment of segments) {
    const match = /^(\d+)([a-z]+)$/.exec(segment);
    if (!match) return LOOP_USAGE;
    const unitMs = TIME_UNITS_MS.get(match[2]!);
    if (unitMs === undefined) {
      return "loop duration unit must be seconds, minutes, or hours";
    }
    const amount = Number(match[1]);
    if (!Number.isSafeInteger(amount) || amount <= 0) return "loop duration must be positive";
    totalMs += amount * unitMs;
  }
  if (totalMs <= 0) return "loop duration must be positive";
  return { kind: "duration", durationMs: totalMs };
}

export function createLoopLimitRuntime(
  config: LoopLimitConfig | undefined,
  nowMs = Date.now(),
): LoopLimitRuntime | undefined {
  if (!config) return undefined;
  if (config.kind === "iterations") {
    return { kind: "iterations", initial: config.iterations, remaining: config.iterations };
  }
  return { kind: "duration", durationMs: config.durationMs, deadlineMs: nowMs + config.durationMs };
}

/** Consume one iteration's budget. False = the limit is exhausted. */
export function consumeLoopLimitIteration(
  limit: LoopLimitRuntime | undefined,
  nowMs = Date.now(),
): boolean {
  if (!limit) return true;
  if (limit.kind === "duration") return nowMs < limit.deadlineMs;
  if (limit.remaining <= 0) return false;
  limit.remaining -= 1;
  return true;
}

export function isLoopDurationExpired(
  limit: LoopLimitRuntime | undefined,
  nowMs = Date.now(),
): boolean {
  return limit?.kind === "duration" && nowMs >= limit.deadlineMs;
}

export function describeLoopLimit(config: LoopLimitConfig): string {
  if (config.kind === "iterations") {
    return `${config.iterations} iteration${config.iterations === 1 ? "" : "s"}`;
  }
  return formatDuration(config.durationMs);
}

export function describeLoopLimitRuntime(limit: LoopLimitRuntime): string {
  if (limit.kind === "iterations") {
    return `${limit.remaining}/${limit.initial} iterations left`;
  }
  return `${formatDuration(Math.max(0, limit.deadlineMs - Date.now()))} left`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  if (minutes < 60) return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h${rest}m` : `${hours}h`;
}
