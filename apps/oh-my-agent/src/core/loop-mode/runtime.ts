import {
  consumeLoopLimitIteration,
  createLoopLimitRuntime,
  describeLoopLimit,
  describeLoopLimitRuntime,
  isLoopDurationExpired,
  LOOP_USAGE,
  type LoopLimitRuntime,
  parseLoopArgs,
} from "./limits.js";

/** What the loop does between iterations before re-submitting the prompt:
 *  re-send it, compact the context first, or start a fresh session first. */
export type LoopAction = "prompt" | "compact" | "reset";

export type LoopStart =
  | { ok: true; prompt?: string; status: string }
  | { ok: false; error: string };

export type LoopIterationDecision =
  | { action: "run"; prompt: string; preamble?: "compact" | "reset" }
  | { action: "stop"; reason: string }
  | { action: "idle" };

export interface LoopStatus {
  state: "waiting" | "running" | "paused";
  limit?: LoopLimitRuntime;
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

  constructor(private readonly action: LoopAction = "prompt") {}

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

  get loopAction(): LoopAction {
    return this.action;
  }

  status(): LoopStatus | undefined {
    if (!this.#enabled) return undefined;
    const state = this.#paused ? "paused" : this.#prompt ? "running" : "waiting";
    const limit = this.#limit;
    return limit ? { state, limit } : { state };
  }

  /** `/loop [count|duration] [prompt]`. Already enabled → disable (toggle),
   *  matching omp. A malformed limit is a hard error and leaves mode alone. */
  toggle(args: string, nowMs = Date.now()): LoopStart {
    if (this.#enabled) {
      this.disable();
      return { ok: true, status: "loop mode disabled" };
    }
    const parsed = parseLoopArgs(args);
    if (typeof parsed === "string") return { ok: false, error: parsed };
    this.#enabled = true;
    this.#paused = false;
    this.#prompt = undefined;
    this.#limit = createLoopLimitRuntime(parsed.limit, nowMs);
    const limitSuffix = parsed.limit ? ` limited to ${describeLoopLimit(parsed.limit)}` : "";
    const remaining = this.#limit ? ` (${describeLoopLimitRuntime(this.#limit)})` : "";
    const tail = parsed.prompt
      ? "repeating it after each turn"
      : "your next prompt will repeat after each turn";
    return {
      ok: true,
      ...(parsed.prompt ? { prompt: parsed.prompt } : {}),
      status: `loop mode enabled${limitSuffix}${remaining} — ${tail}; /loop again disables, Esc pauses`,
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
    return wasEnabled && reason ? reason : "loop mode disabled";
  }

  /** One settled run: may the loop re-submit? Consumes a limit iteration
   *  (consume the budget BEFORE acting, so an exhausted limit
   *  disables instead of running one extra turn). */
  nextIteration(nowMs = Date.now()): LoopIterationDecision {
    if (!this.#enabled || !this.#prompt) return { action: "idle" };
    const prompt = this.#prompt;
    if (isLoopDurationExpired(this.#limit, nowMs)) {
      return { action: "stop", reason: "loop time limit reached" };
    }
    if (!consumeLoopLimitIteration(this.#limit, nowMs)) {
      return { action: "stop", reason: "loop limit reached" };
    }
    if (this.action === "compact" || this.action === "reset") {
      return { action: "run", prompt, preamble: this.action };
    }
    return { action: "run", prompt };
  }
}

export { LOOP_USAGE };
