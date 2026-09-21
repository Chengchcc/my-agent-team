import type { BashSandbox } from "../tools/bash-sandbox.js";

/** Deterministic continue-condition for loop mode: a shell command whose EXIT
 *  STATUS decides whether the next iteration runs.
 *
 *  Exit status is authoritative and stdout is ignored. `echo false` exits 0,
 *  so "boolean-ish output" and the exit code actively disagree on the same
 *  command, and every predicate a user already reaches for (`test`, `grep -q`,
 *  `git diff --quiet`, `&&`) speaks exit codes.
 *
 *  Exit 1 is the only "condition is false" status. Anything higher (127
 *  command not found, 126 not executable, 2 syntax error) means the CONDITION
 *  itself is broken and is surfaced as an error instead of being read as
 *  "false" — otherwise a typo'd condition halts the loop looking exactly like
 *  finished work, which is the failure mode this feature exists to avoid. */

export interface LoopConditionConfig {
  /** Shell command; its exit status decides. */
  command: string;
  /** true = `--until` (stop when the command succeeds); false = `--while`
   *  (stop when it fails). */
  until: boolean;
}

export type LoopConditionVerdict =
  /** Another iteration should run. */
  | { kind: "continue" }
  /** The condition resolved cleanly and says stop. */
  | { kind: "halt"; message: string }
  /** The condition command is broken or timed out: stop and say why. */
  | { kind: "error"; message: string }
  /** Aborted mid-evaluation (Esc); the caller owns that UX. */
  | { kind: "aborted" };

export interface LoopConditionOptions {
  cwd: string;
  /** Deadline for one evaluation; 0 disables it. */
  timeoutMs: number;
  signal?: AbortSignal;
  /** Sandbox the condition runs under (absent = unconfined). Conditions are
   *  the same trust class as a bash tool call, so a run that opted into the OS
   *  sandbox keeps it here too. */
  sandbox?: BashSandbox;
}

interface ConditionProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number | null>;
  kill(): void;
}

export const DEFAULT_CONDITION_TIMEOUT_MS = 120_000;

/** Human-readable form of the condition, for enable/status messages. */
export function describeLoopCondition(condition: LoopConditionConfig): string {
  return `${condition.until ? "until" : "while"} ${quoteCommand(condition.command)} succeeds`;
}

function quoteCommand(command: string): string {
  const flat = command.replace(/\s+/g, " ").trim();
  const bounded = flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
  return `\`${bounded}\``;
}

/** First meaningful line of a failed condition's output, bounded. */
function previewOutput(output: string): string {
  const line = output
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "";
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

function formatTimeout(timeoutMs: number): string {
  if (timeoutMs < 60_000) return `${Math.round(timeoutMs / 1_000)}s`;
  const minutes = Math.round(timeoutMs / 60_000);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** Run one evaluation and map the exit status onto a loop verdict. Never
 *  throws: a condition that cannot even start is an error verdict. */
export async function evaluateLoopCondition(
  condition: LoopConditionConfig,
  options: LoopConditionOptions,
): Promise<LoopConditionVerdict> {
  let proc: ConditionProcess | undefined;
  let timer: Timer | undefined;
  let timedOut = false;
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    proc?.kill();
  };
  try {
    proc = startCondition(condition, options);
    // Start draining BEFORE awaiting the exit: a condition whose output fills
    // the pipe buffer would otherwise block forever on the write side.
    const drained = collect(proc);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const exitCode = await Promise.race([
      proc.exited,
      options.timeoutMs > 0
        ? new Promise<number | null>((resolve) => {
            timer = setTimeout(() => {
              timedOut = true;
              proc?.kill();
              resolve(124); // conventional timeout status
            }, options.timeoutMs);
          })
        : new Promise<number | null>(() => {}),
    ]);
    // Timeout before abort: both can stop the process, and the distinction
    // matters — a deadline is a broken condition, Esc is not.
    if (timedOut) {
      return {
        kind: "error",
        message: `loop condition ${quoteCommand(condition.command)} timed out after ${formatTimeout(options.timeoutMs)}`,
      };
    }
    if (aborted) return { kind: "aborted" };
    const output = await drained;

    if (exitCode === 0) {
      if (!condition.until) return { kind: "continue" };
      return {
        kind: "halt",
        message: `loop condition ${quoteCommand(condition.command)} is now satisfied`,
      };
    }
    if (exitCode === 1) {
      if (condition.until) return { kind: "continue" };
      return {
        kind: "halt",
        message: `loop condition ${quoteCommand(condition.command)} no longer holds`,
      };
    }
    // Exit >1 (or a signal death, which reports no status) is the condition
    // breaking, not answering.
    const preview = previewOutput(output);
    const detail = preview ? `: ${preview}` : "";
    const status = exitCode === null ? "no exit status" : `exit ${exitCode}`;
    return {
      kind: "error",
      message: `loop condition ${quoteCommand(condition.command)} failed (${status})${detail}`,
    };
  } catch (err) {
    return {
      kind: "error",
      message: `loop condition ${quoteCommand(condition.command)} could not run: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** The condition runs in its OWN process, never the interactive shell: a `cd`
 *  inside a condition must not move the session's working directory, and
 *  stdin is closed so a predicate can never block on the terminal. When the
 *  run has an OS sandbox, the condition inherits it. */
function startCondition(
  condition: LoopConditionConfig,
  options: LoopConditionOptions,
): ConditionProcess {
  if (options.sandbox) {
    const spawned = options.sandbox.spawn(condition.command, { cwd: options.cwd });
    return {
      stdout: spawned.stdout,
      stderr: spawned.stderr,
      exited: spawned.exited,
      kill: () => spawned.kill(),
    };
  }
  const proc = Bun.spawn(["bash", "-c", condition.command], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    cwd: options.cwd,
  });
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    exited: proc.exited,
    kill: () => proc.kill(),
  };
}

/** Merge both pipes into one bounded string. Runs concurrently with the exit
 *  await, so a chatty condition cannot deadlock on a full pipe. */
async function collect(proc: ConditionProcess): Promise<string> {
  const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.length > 8_000) out = out.slice(-8_000); // bounded preview buffer
    }
    return out;
  };
  const [stdout, stderr] = await Promise.all([
    read(proc.stdout).catch(() => ""),
    read(proc.stderr).catch(() => ""),
  ]);
  return `${stdout}${stderr}`;
}
