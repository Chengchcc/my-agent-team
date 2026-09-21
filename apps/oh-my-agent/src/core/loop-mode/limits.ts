import type { LoopConditionConfig } from "./condition.js";

/** Loop-mode argument grammar and limits.
 *
 *  `/loop [count|duration] [--while|--until <command>] [prompt]`: a leading
 *  token that LOOKS like a limit (starts with a digit or sign) or a FLAG
 *  (starts with `--`) is parsed as one, and a malformed one is a hard error;
 *  anything else is prose, i.e. the loop prompt — so `/loop keep going` starts
 *  an unbounded loop instead of erroring. */

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
  /** Continue-condition from `--while` / `--until`, re-evaluated before each
   *  iteration; absent = unconditional. */
  condition?: LoopConditionConfig;
  /** Inline loop prompt: text after the limit and flags, or the whole
   *  argument when neither was given. */
  prompt?: string;
}

export function parseLoopArgs(args: string): ParsedLoopArgs | string {
  const trimmed = args.trim();
  if (!trimmed) return {};

  const limitResult = takeLoopLimit(trimmed);
  if (typeof limitResult === "string") return limitResult;
  const conditionResult = takeLoopCondition(limitResult.rest);
  if (typeof conditionResult === "string") return conditionResult;

  const parsed: ParsedLoopArgs = {};
  if (limitResult.limit) parsed.limit = limitResult.limit;
  if (conditionResult.condition) parsed.condition = conditionResult.condition;
  if (conditionResult.rest) parsed.prompt = conditionResult.rest;
  return parsed;
}

/** Split an optional leading limit token off the argument string. */
function takeLoopLimit(input: string): { limit?: LoopLimitConfig; rest: string } | string {
  const firstSpace = input.search(/\s/);
  const firstToken = firstSpace === -1 ? input : input.slice(0, firstSpace);
  const rest = firstSpace === -1 ? "" : input.slice(firstSpace + 1).trim();
  const token = firstToken.toLowerCase();

  // Not a limit attempt (prose, or a leading condition flag).
  if (!/^[+-]?\d/.test(token)) return { rest: input };

  // Bare integer: iteration count, unless the next token is a time unit
  // ("10 minutes").
  if (/^\d+$/.test(token)) {
    if (rest) {
      const unitToken = /^\S+/.exec(rest)?.[0] ?? "";
      const unitMs = TIME_UNITS_MS.get(unitToken.toLowerCase());
      if (unitMs !== undefined) {
        const limit = makeDuration(token, unitMs);
        if (typeof limit === "string") return limit;
        return { limit, rest: rest.slice(unitToken.length).trim() };
      }
    }
    const limit = makeIterations(token);
    if (typeof limit === "string") return limit;
    return { limit, rest };
  }

  // Compact / compound duration: "10m", "90s", "1h30m".
  const duration = parseCompoundDuration(token);
  if (duration !== undefined) {
    if (typeof duration === "string") return duration;
    return { limit: duration, rest };
  }

  // Limit-shaped but unparseable ("-1", "1.5h", "10x10").
  return LOOP_USAGE;
}

/** Split an optional leading `--while` / `--until` flag off the argument
 *  string. A flag-shaped token that does not parse is a hard error, so a typo
 *  surfaces instead of silently becoming prompt text. */
function takeLoopCondition(
  input: string,
): { condition?: LoopConditionConfig; rest: string } | string {
  let rest = input.trim();
  let condition: LoopConditionConfig | undefined;

  while (rest.startsWith("--")) {
    const name = /^(--[a-z][a-z-]*)(?=[\s=]|$)/.exec(rest)?.[1];
    const until = name === undefined ? undefined : CONDITION_FLAGS[name];
    if (name === undefined || until === undefined) {
      return `unknown /loop flag ${name ?? rest.split(/\s+/, 1)[0]}. ${LOOP_USAGE}`;
    }
    if (condition) return "use only one of --while or --until";

    const afterName = rest.slice(name.length);
    const valueText = afterName.startsWith("=") ? afterName.slice(1) : afterName;
    const value = readShellWord(valueText);
    if (value === "unterminated") return `${name} has an unterminated quote`;
    if (value === undefined || !value.value.trim() || valueText.trim().startsWith("-")) {
      return `${name} needs a shell command. Quote it when it contains spaces: /loop ${name} 'bun test'`;
    }
    condition = { command: value.value.trim(), until };
    rest = value.rest;
  }

  return { condition, rest };
}

/** `--until` stops when the command SUCCEEDS; `--while` stops when it fails. */
const CONDITION_FLAGS: Record<string, boolean> = { "--until": true, "--while": false };

/** Read one shell word, honoring single/double quotes (the condition is a
 *  command line, so it usually needs quoting). Returns "unterminated" for an
 *  unbalanced quote rather than guessing. */
function readShellWord(
  input: string,
): { value: string; rest: string } | "unterminated" | undefined {
  const trimmed = input.replace(/^\s+/, "");
  if (trimmed === "") return undefined;
  let out = "";
  let quote: '"' | "'" | undefined;
  let i = 0;
  for (; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (quote) {
      if (ch === quote) {
        quote = undefined;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) break;
    out += ch;
  }
  if (quote) return "unterminated";
  return { value: out, rest: trimmed.slice(i).trim() };
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
