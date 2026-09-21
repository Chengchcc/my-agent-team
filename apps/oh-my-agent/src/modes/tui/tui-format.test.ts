import { describe, expect, test } from "bun:test";
import {
  formatGoalInput,
  formatRalphInput,
  formatSettlementText,
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
