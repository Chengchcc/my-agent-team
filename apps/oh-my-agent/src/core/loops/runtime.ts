import {
  describeLoopCondition,
  evaluateLoopCondition,
  type LoopConditionConfig,
  type LoopConditionOptions,
} from "./condition.js";
import {
  consumeLoopLimitIteration,
  createLoopLimitRuntime,
  describeLoopLimit,
  describeLoopLimitRuntime,
  isLoopDurationExpired,
  LOOP_USAGE,
  type LoopLimitRuntime,
  type ParsedLoopArgs,
  parseLoopArgs,
} from "./limits.js";
import { RALPH_PROTOCOL, RALPH_QUEUE, ralphCondition, seedRalphQueue } from "./ralph.js";

/** What the loop does between iterations before re-submitting the prompt:
 *  re-send it, compact the context first, start a fresh session first, or run
 *  the build loop (fresh session + a work queue on disk, see ralph.ts). */
export type LoopAction = "prompt" | "compact" | "reset" | "ralph";

export type LoopStart =
  | { ok: true; prompt?: string; hidden?: true; status: string }
  | { ok: false; error: string };

export type LoopIterationDecision =
  | {
      action: "run";
      prompt: string;
      preamble?: "compact" | "reset";
      /** The prompt is protocol, not user text: the transcript must not echo
       *  it as a turn the user typed (`isHiddenInput` handles the wrapping). */
      hidden?: true;
    }
  | { action: "stop"; reason: string }
  | { action: "idle" };

export interface LoopStatus {
  state: "waiting" | "running" | "paused";
  limit?: LoopLimitRuntime;
  /** Remaining budget + continue-condition, for the status bar. */
  label?: string;
}

/** Loop mode (the reference loop implementation (enabled / captured prompt / limit)).
 *
 *  While enabled, the next prompt the user sends is remembered and
 *  re-submitted after every yield. The loop is NOT a scheduler: it fires only
 *  when the session is idle and the run has settled, with a short delay so an
 *  interrupt can land between iterations. It is session-scoped and
 *  deliberately in-memory — a resumed session never re-enters a loop on its
 *  own (same rule as goal mode). */
export class LoopRuntime {
  #enabled = false;
  #paused = false;
  #prompt: string | undefined;
  #limit: LoopLimitRuntime | undefined;
  #condition: LoopConditionConfig | undefined;

  constructor(private action: LoopAction = "prompt") {}

  /** Re-arm for a different strategy. `/ralph` forces the build loop whatever
   *  the project setting says, and one runtime is created per session, so the
   *  action has to be switchable after construction. */
  useAction(action: LoopAction): void {
    this.action = action;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get paused(): boolean {
    return this.#paused;
  }

  get prompt(): string | undefined {
    return this.#prompt;
  }

  get limit(): LoopLimitRuntime | undefined {
    return this.#limit;
  }

  get condition(): LoopConditionConfig | undefined {
    return this.#condition;
  }

  /** Human-readable condition, for status messages. */
  get conditionLabel(): string | undefined {
    return this.#condition ? describeLoopCondition(this.#condition) : undefined;
  }

  /** The status-bar indicator: waiting / running / paused plus the remaining
   *  budget and the condition. The driver owns its wording. */
  statusLabel(): string | undefined {
    const status = this.status();
    if (!status) return undefined;
    if (status.state === "paused") return "⏸ loop paused";
    const name = this.action === "ralph" ? "ralph" : "loop";
    return `↻ ${name}${status.label ? ` ${status.label}` : ""}`;
  }

  get loopAction(): LoopAction {
    return this.action;
  }

  status(): LoopStatus | undefined {
    if (!this.#enabled) return undefined;
    // The build loop needs no captured prompt: its protocol is fixed and the
    // queue is on disk, so an enabled build loop is running, not waiting.
    const armed = this.action === "ralph" || this.#prompt !== undefined;
    const state = this.#paused ? "paused" : armed ? "running" : "waiting";
    const status: LoopStatus = { state };
    if (this.#limit) status.limit = this.#limit;
    // The bar shows WHAT will decide the next iteration, not just that one is
    // pending: the remaining budget and, when set, the continue-condition.
    const label = [
      this.#limit ? describeLoopLimitRuntime(this.#limit) : undefined,
      this.conditionLabel,
    ]
      .filter(Boolean)
      .join(" · ");
    if (label) status.label = label;
    return status;
  }

  /** `/loop [count|duration] [prompt]`. Already enabled → disable (toggle),
   *  matching the reference loop. A malformed limit is a hard error and
   *  leaves the mode alone. */
  toggle(args: string, nowMs = Date.now()): LoopStart {
    if (this.#enabled) {
      this.disable();
      return { ok: true, status: "loop mode disabled" };
    }
    const parsed = parseLoopArgs(args);
    if (typeof parsed === "string") return { ok: false, error: parsed };
    return this.#arm(parsed, nowMs);
  }

  /** `/ralph [count|duration] [--while|--until cmd] [item]`: switch to the
   *  build loop, seed the work queue on first use, and start. Like `toggle` it
   *  re-arms rather than toggling off — the caller decides whether a second
   *  invocation means "stop" (see the `/ralph` command). */
  startRalph(workspaceRoot: string, args: string, nowMs = Date.now()): LoopStart {
    if (this.#enabled) this.disable();
    const parsed = parseLoopArgs(args);
    if (typeof parsed === "string") return { ok: false, error: parsed };
    this.action = "ralph";
    const queue = seedRalphQueue(workspaceRoot, parsed.prompt);
    const started = this.#arm(parsed, nowMs);
    if (!started.ok || !queue.created) return started;
    return { ...started, status: `${started.status}; seeded ${queue.path}` };
  }

  #arm(parsed: ParsedLoopArgs, nowMs: number): LoopStart {
    const build = this.action === "ralph";
    this.#enabled = true;
    this.#paused = false;
    // The build loop's prompt is its protocol, never a captured user turn, so
    // the parsed trailing text seeds the queue instead (see startRalph).
    this.#prompt = build ? undefined : parsed.prompt;
    this.#limit = createLoopLimitRuntime(parsed.limit, nowMs);
    // The queue is the build loop's default authority on whether to continue;
    // an explicit --while/--until replaces it.
    this.#condition = parsed.condition ?? (build ? ralphCondition() : undefined);
    const limitSuffix = parsed.limit ? ` limited to ${describeLoopLimit(parsed.limit)}` : "";
    const conditionSuffix = this.#condition ? ` — ${describeLoopCondition(this.#condition)}` : "";
    const remaining = this.#limit ? ` (${describeLoopLimitRuntime(this.#limit)})` : "";
    if (build) {
      return {
        ok: true,
        prompt: RALPH_PROTOCOL,
        hidden: true,
        status: `build loop enabled${limitSuffix}${remaining}${conditionSuffix} — one ${RALPH_QUEUE} item per fresh session; /ralph again disables, Esc pauses`,
      };
    }
    const tail = parsed.prompt
      ? "repeating it after each turn"
      : "your next prompt will repeat after each turn";
    return {
      ok: true,
      ...(parsed.prompt ? { prompt: parsed.prompt } : {}),
      status: `loop mode enabled${limitSuffix}${remaining}${conditionSuffix} — ${tail}; /loop again disables, Esc pauses`,
    };
  }

  /** The first incoming prompt while enabled becomes the loop prompt (omp
   *  setLoopPrompt: also clears a pause — the next user prompt re-arms it). */
  capturePrompt(text: string): void {
    if (!this.#enabled) return;
    this.#prompt = text;
    this.#paused = false;
  }

  /** Pause without exiting: drop the captured prompt, keep mode enabled (omp
   *  pauseLoop — Esc between iterations lands here). */
  pause(): void {
    if (!this.#enabled) return;
    this.#prompt = undefined;
    this.#paused = true;
  }

  disable(reason?: string): string {
    const wasEnabled = this.#enabled;
    this.#enabled = false;
    this.#paused = false;
    this.#prompt = undefined;
    this.#limit = undefined;
    this.#condition = undefined;
    return wasEnabled && reason ? reason : "loop mode disabled";
  }

  /** One settled run: may the loop re-submit?
   *
   *  Order matters. The condition gate runs BEFORE the budget is consumed, so
   *  a halt never burns an iteration that did not run; the duration deadline
   *  runs first of all, because an expired clock ends the loop regardless of
   *  what the condition would have said. */
  async nextIteration(
    opts: Omit<LoopConditionOptions, "timeoutMs"> & { timeoutMs?: number } = {
      cwd: process.cwd(),
    },
    nowMs = Date.now(),
  ): Promise<LoopIterationDecision> {
    if (!this.#enabled) return { action: "idle" };
    // The build loop re-injects its protocol rather than a captured turn, so
    // "waiting for a prompt" does not apply to it — but a pause does: pause()
    // is the only thing that must stop it (Esc between iterations).
    const build = this.action === "ralph";
    const prompt = build ? RALPH_PROTOCOL : this.#prompt;
    if (prompt === undefined || this.#paused) return { action: "idle" };
    if (isLoopDurationExpired(this.#limit, nowMs)) {
      return { action: "stop", reason: "loop time limit reached" };
    }
    if (this.#condition) {
      const verdict = await evaluateLoopCondition(this.#condition, {
        ...opts,
        timeoutMs: opts.timeoutMs ?? 120_000,
      });
      if (verdict.kind === "aborted") return { action: "idle" };
      // The await above is a window: Esc (pause) or /loop (disable) can land
      // while the condition runs, which makes ANY verdict stale — a user who
      // paused mid-evaluation must not have the loop stopped out from under
      // them by a halt they never saw coming. The build loop has no captured
      // prompt to compare against, so `paused` is its whole staleness check.
      if (!this.#enabled || this.#paused || (!build && this.#prompt !== prompt)) {
        return { action: "idle" };
      }
      if (verdict.kind === "halt" || verdict.kind === "error") {
        return { action: "stop", reason: verdict.message };
      }
    }
    if (!consumeLoopLimitIteration(this.#limit, nowMs)) {
      return { action: "stop", reason: "loop limit reached" };
    }
    // The build loop restarts the session every iteration: stale context is
    // the failure mode it exists to avoid, and the queue carries what matters.
    if (build) return { action: "run", prompt, preamble: "reset", hidden: true };
    if (this.action === "compact" || this.action === "reset") {
      return { action: "run", prompt, preamble: this.action };
    }
    return { action: "run", prompt };
  }
}

export { LOOP_USAGE };
