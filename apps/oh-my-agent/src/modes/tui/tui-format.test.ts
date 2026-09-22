import { describe, expect, test } from "bun:test";
import {
  elideMiddle,
  formatGoalInput,
  formatRalphInput,
  formatSettlementText,
  formatWorkspace,
  isHiddenInput,
  SETTLEMENT_SENTINEL,
} from "./tui-format.js";

/** The hidden-input channel (omp `display: false` analogue): goal-mode
 *  protocol prompts and background-job settlements reach the MODEL as run
 *  input but must produce no transcript echo and no session-file entry —
 *  otherwise /resume replays multi-KB XML as phantom user bubbles. */
describe("hidden run-input channel", () => {
  test("settlements and goal prompts are hidden; real user text is not", () => {
    expect(isHiddenInput(formatSettlementText([]))).toBe(true);
    expect(isHiddenInput(formatGoalInput("<goal_context>\nobjective\n</goal_context>"))).toBe(true);
    expect(isHiddenInput(SETTLEMENT_SENTINEL)).toBe(true);
    // The build loop re-injects its protocol every iteration: echoed or
    // persisted, it would bury the transcript under identical turns.
    expect(isHiddenInput(formatRalphInput("You are one iteration"))).toBe(true);
    expect(isHiddenInput("[ralph-loop]")).toBe(true);
    // Ordinary prompts — including ones that merely MENTION the goal — stay
    // visible: only the exact prefix marks the channel.
    expect(isHiddenInput("make the tests pass")).toBe(false);
    expect(isHiddenInput("what is [goal-mode]?")).toBe(false);
    expect(isHiddenInput("")).toBe(false);
  });

  test("formatGoalInput keeps the prompt intact under the sentinel", () => {
    const prompt = "<goal_context>\ncontinue the goal\n</goal_context>";
    const wrapped = formatGoalInput(prompt);
    expect(wrapped.startsWith("[goal-mode]")).toBe(true);
    expect(wrapped).toContain(prompt);
    expect(isHiddenInput(wrapped)).toBe(true);
  });
});

describe("formatWorkspace / elideMiddle", () => {
  test("short paths pass through unchanged", () => {
    expect(elideMiddle("/a/b", 48)).toBe("/a/b");
    expect(elideMiddle("x", 2)).toBe("x");
  });

  test("long paths drop middle segments, keeping the anchor and the tail", () => {
    const out = elideMiddle("/root/agent-ws/projects/p1.a-very-long-task-slug", 32);
    expect(out.length).toBeLessThanOrEqual(32);
    expect(out.startsWith("/…/")).toBe(true);
    expect(out.endsWith("p1.a-very-long-task-slug")).toBe(true);
  });

  test("a single very long segment falls back to a head…tail cut", () => {
    const out = elideMiddle(`/${"z".repeat(80)}`, 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).toContain("…");
  });

  test("HOME collapses to ~ before eliding", () => {
    const prev = process.env.HOME;
    process.env.HOME = "/home/dev";
    try {
      expect(formatWorkspace("/home/dev/short")).toBe("~/short");
      const long = formatWorkspace("/home/dev/ws/projects/p1.some-long-slug", 24);
      expect(long.length).toBeLessThanOrEqual(24);
      expect(long.startsWith("~")).toBe(true);
    } finally {
      process.env.HOME = prev;
    }
  });
});
