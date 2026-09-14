import { describe, expect, test } from "bun:test";
import { MAX_BASH_TIMEOUT_MS, MAX_EVAL_TIMEOUT_MS } from "../tools/index.js";
import { wrapperBackstopMs } from "./run-runtime.js";

/** The wrapper's deadline must sit ABOVE a tool's own ceiling: a tool that
 *  parses the model's per-call `timeout` (bash/eval) owns the deadline, and a
 *  30s wrapper used to preempt it ("bash timed out after 30000ms" for a call
 *  that asked for 60000 — a real scp session died this way). */
describe("native-tool wrapper backstop", () => {
  test("bash/eval backstops are at least their own ceilings", () => {
    expect(wrapperBackstopMs("bash")).toBeGreaterThanOrEqual(MAX_BASH_TIMEOUT_MS);
    expect(wrapperBackstopMs("eval")).toBeGreaterThanOrEqual(MAX_EVAL_TIMEOUT_MS);
  });

  test("a realistic per-call timeout is reachable through the wrapper", () => {
    // 60s is the scp case; 600s is the documented bash maximum.
    expect(wrapperBackstopMs("bash")).toBeGreaterThan(60_000);
    expect(wrapperBackstopMs("bash")).toBeGreaterThanOrEqual(600_000);
  });

  test("other tools keep the generic 30s backstop", () => {
    expect(wrapperBackstopMs("read")).toBe(30_000);
    expect(wrapperBackstopMs("grep")).toBe(30_000);
  });
});
