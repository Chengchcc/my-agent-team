import { describe, expect, test } from "bun:test";
import {
  consumeLoopLimitIteration,
  createLoopLimitRuntime,
  describeLoopLimit,
  isLoopDurationExpired,
  parseLoopArgs,
} from "./limits.js";
import { LoopRuntime } from "./runtime.js";

describe("parseLoopArgs (limit parsing)", () => {
  test("no args → unbounded, no prompt", () => {
    expect(parseLoopArgs("")).toEqual({});
    expect(parseLoopArgs("   ")).toEqual({});
  });

  test("prose is the prompt, not a limit (keyword-driven loops)", () => {
    expect(parseLoopArgs("keep going")).toEqual({ prompt: "keep going" });
    expect(parseLoopArgs("run the tests and fix failures")).toEqual({
      prompt: "run the tests and fix failures",
    });
  });

  test("bare integer is an iteration count", () => {
    expect(parseLoopArgs("10")).toEqual({ limit: { kind: "iterations", iterations: 10 } });
    expect(parseLoopArgs("3 fix it")).toEqual({
      limit: { kind: "iterations", iterations: 3 },
      prompt: "fix it",
    });
  });

  test("integer + time unit is a duration", () => {
    expect(parseLoopArgs("10 minutes")).toEqual({
      limit: { kind: "duration", durationMs: 600_000 },
    });
    expect(parseLoopArgs("2 hours tidy the docs")).toEqual({
      limit: { kind: "duration", durationMs: 7_200_000 },
      prompt: "tidy the docs",
    });
  });

  test("compact and compound durations", () => {
    expect(parseLoopArgs("10m")).toEqual({ limit: { kind: "duration", durationMs: 600_000 } });
    expect(parseLoopArgs("90s")).toEqual({ limit: { kind: "duration", durationMs: 90_000 } });
    expect(parseLoopArgs("1h30m keep polishing")).toEqual({
      limit: { kind: "duration", durationMs: 5_400_000 },
      prompt: "keep polishing",
    });
  });

  test("limit-shaped but malformed is a HARD error, never silently prose", () => {
    expect(parseLoopArgs("-1")).toContain("usage: /loop");
    expect(parseLoopArgs("1.5h")).toContain("usage: /loop");
    expect(parseLoopArgs("0")).toContain("positive integer");
    expect(parseLoopArgs("10x10")).toContain("usage: /loop");
    // omp: an unknown word after a bare integer is PROMPT text, not a unit —
    // only a duration-SHAPED token ("1.5h", "10x10") is an error.
    expect(parseLoopArgs("5 lightyears")).toEqual({
      limit: { kind: "iterations", iterations: 5 },
      prompt: "lightyears",
    });
  });
});

describe("loop limits", () => {
  test("iteration budget decrements to exhaustion", () => {
    const limit = createLoopLimitRuntime({ kind: "iterations", iterations: 2 });
    expect(consumeLoopLimitIteration(limit)).toBe(true);
    expect(consumeLoopLimitIteration(limit)).toBe(true);
    expect(consumeLoopLimitIteration(limit)).toBe(false);
  });

  test("duration budget expires on the clock, not on a count", () => {
    const limit = createLoopLimitRuntime({ kind: "duration", durationMs: 1_000 }, 0);
    expect(consumeLoopLimitIteration(limit, 500)).toBe(true);
    expect(consumeLoopLimitIteration(limit, 1_500)).toBe(false);
    expect(isLoopDurationExpired(limit, 1_500)).toBe(true);
    expect(isLoopDurationExpired(limit, 500)).toBe(false);
    // No limit = unbounded.
    expect(consumeLoopLimitIteration(undefined)).toBe(true);
  });

  test("descriptions name the budget", () => {
    expect(describeLoopLimit({ kind: "iterations", iterations: 1 })).toBe("1 iteration");
    expect(describeLoopLimit({ kind: "iterations", iterations: 5 })).toBe("5 iterations");
    expect(describeLoopLimit({ kind: "duration", durationMs: 5_400_000 })).toBe("1h30m");
  });
});

describe("LoopRuntime (loop mode)", () => {
  test("toggle enables with a status naming the limit; toggling again disables", () => {
    const rt = new LoopRuntime();
    const start = rt.toggle("5 polish the docs");
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(start.prompt).toBe("polish the docs");
    expect(start.status).toContain("limited to 5 iterations");
    expect(start.status).toContain("(5/5 iterations left)");
    expect(rt.enabled).toBe(true);
    const off = rt.toggle("");
    expect(off.ok).toBe(true);
    expect(rt.enabled).toBe(false);
  });

  test("a malformed limit leaves the mode untouched", () => {
    const rt = new LoopRuntime();
    const bad = rt.toggle("1.5h");
    expect(bad.ok).toBe(false);
    expect(rt.enabled).toBe(false);
  });

  test("first prompt is captured; pause drops it but keeps the mode armed", () => {
    const rt = new LoopRuntime();
    rt.toggle("");
    expect(rt.status()?.state).toBe("waiting");
    rt.capturePrompt("run the tests");
    expect(rt.status()?.state).toBe("running");
    rt.pause();
    expect(rt.status()?.state).toBe("paused");
    expect(rt.prompt).toBeUndefined();
    expect(rt.enabled).toBe(true);
    // The next prompt re-arms the loop (omp: pause is not exit).
    rt.capturePrompt("next thing");
    expect(rt.status()?.state).toBe("running");
    expect(rt.nextIteration()).toEqual({ action: "run", prompt: "next thing" });
  });

  test("iterations are consumed per iteration and stop the loop at the limit", () => {
    const rt = new LoopRuntime();
    rt.toggle("2 go");
    rt.capturePrompt("go");
    expect(rt.nextIteration()).toEqual({ action: "run", prompt: "go" });
    expect(rt.nextIteration()).toEqual({ action: "run", prompt: "go" });
    expect(rt.nextIteration()).toEqual({ action: "stop", reason: "loop limit reached" });
  });

  test("compact/reset actions carry a preamble", () => {
    const compact = new LoopRuntime("compact");
    compact.toggle("");
    compact.capturePrompt("go");
    expect(compact.nextIteration()).toEqual({ action: "run", prompt: "go", preamble: "compact" });
    const reset = new LoopRuntime("reset");
    reset.toggle("");
    reset.capturePrompt("go");
    expect(reset.nextIteration()).toEqual({ action: "run", prompt: "go", preamble: "reset" });
  });

  test("idle when disabled or without a captured prompt", () => {
    const rt = new LoopRuntime();
    expect(rt.nextIteration()).toEqual({ action: "idle" });
    rt.toggle("");
    expect(rt.nextIteration()).toEqual({ action: "idle" });
    expect(rt.status()?.state).toBe("waiting");
  });

  test("disable clears prompt + limit and reports the reason once", () => {
    const rt = new LoopRuntime();
    rt.toggle("5 go");
    rt.capturePrompt("go");
    expect(rt.disable("loop limit reached")).toBe("loop limit reached");
    expect(rt.enabled).toBe(false);
    expect(rt.status()).toBeUndefined();
    // Disabling an already-off loop does not repeat the reason.
    expect(rt.disable("loop limit reached")).toBe("loop mode disabled");
  });
});
