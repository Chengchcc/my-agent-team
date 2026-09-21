import { describe, expect, test } from "bun:test";
import {
  accountTurn,
  canCreateGoal,
  completeGoal,
  createGoal,
  goalTokenDelta,
  isAccountingStatus,
  pauseGoal,
  remainingTokens,
  renderGoalPrompt,
  renderInterviewPrompt,
  resumeGoal,
  validateTokenBudget,
} from "./state.js";

describe("goal state machine (omp port)", () => {
  test("create → complete round-trips with exiting mode", () => {
    const state = createGoal("tests pass", 1000);
    expect(state.goal.status).toBe("active");
    expect(state.enabled).toBe(true);
    expect(canCreateGoal(state)).toBe(false);
    const done = completeGoal(state);
    expect(done.goal.status).toBe("complete");
    expect(done.enabled).toBe(false);
    expect(done.mode).toBe("exiting");
    expect(done.reason).toBe("completed");
    expect(canCreateGoal(done)).toBe(true);
  });

  test("pause → resume round-trips; complete/dropped are terminal", () => {
    const state = createGoal("obj");
    const paused = pauseGoal(state);
    expect(paused.goal.status).toBe("paused");
    expect(paused.enabled).toBe(false);
    const resumed = resumeGoal(paused);
    expect(resumed.goal.status).toBe("active");
    expect(resumed.enabled).toBe(true);
    expect(() => resumeGoal(completeGoal(state))).toThrow(/already complete/);
  });

  test("budget validation", () => {
    expect(() => validateTokenBudget(0)).toThrow();
    expect(() => validateTokenBudget(1.5)).toThrow();
    expect(() => validateTokenBudget(100)).not.toThrow();
    expect(() => createGoal("x", -1)).toThrow();
    expect(() => createGoal("  ")).toThrow(/objective is required/);
  });

  test("token delta: input+output+cacheWrite, never cacheRead", () => {
    expect(
      goalTokenDelta({
        inputTokens: 10,
        outputTokens: 5,
        cacheWriteTokens: 100,
        cacheReadTokens: 999,
      }),
    ).toBe(115);
  });

  test("accounting: accumulates on active, flips to budget-limited once, stops when disabled", () => {
    const state = createGoal("obj", 100);
    const first = accountTurn(state, { inputTokens: 60 }, 30);
    expect(first.state.goal.tokensUsed).toBe(60);
    expect(first.state.goal.timeUsedSeconds).toBe(30);
    expect(first.crossedBudget).toBe(false);
    // 60 + 50 ≥ 100 → crosses THIS turn only.
    const second = accountTurn(first.state, { inputTokens: 50 }, 30);
    expect(second.crossedBudget).toBe(true);
    expect(second.state.goal.status).toBe("budget-limited");
    // Still an accounting status; but crossing again is not re-reported.
    const third = accountTurn(second.state, { inputTokens: 10 }, 5);
    expect(third.crossedBudget).toBe(false);
    expect(third.state.goal.tokensUsed).toBe(120);
    // Paused goals do not account.
    const paused = pauseGoal(second.state);
    expect(accountTurn(paused, { inputTokens: 10 }, 5).state.goal.tokensUsed).toBe(110);
  });

  test("remaining tokens: null without budget, floored at zero", () => {
    expect(remainingTokens(createGoal("o").goal)).toBeNull();
    expect(remainingTokens(createGoal("o", 10).goal)).toBe(10);
    const spent = accountTurn(createGoal("o", 10), { inputTokens: 25 }, 0);
    expect(remainingTokens(spent.state.goal)).toBe(0);
  });

  test("isAccountingStatus: active and budget-limited only", () => {
    expect(isAccountingStatus(createGoal("o").goal)).toBe(true);
    expect(
      isAccountingStatus(accountTurn(createGoal("o", 1), { inputTokens: 5 }, 0).state.goal),
    ).toBe(true);
    expect(isAccountingStatus(pauseGoal(createGoal("o")).goal)).toBe(false);
  });
});

describe("goal prompts (omp disciplines preserved)", () => {
  test("all three kinds carry objective + budget and the load-bearing rules", () => {
    const goal = createGoal("make `bun test` exit 0", 5000).goal;
    for (const kind of ["active", "continuation", "budget-limit"] as const) {
      const text = renderGoalPrompt(kind, goal);
      expect(text).toContain("<objective>");
      expect(text).toContain("bun test");
      expect(text).toContain("Tokens used: 0");
      expect(text).toContain("Token budget: 5000");
      expect(text).toContain("≠ completion");
    }
    expect(renderGoalPrompt("continuation", goal)).toContain(
      "NEVER redefine success as a smaller, easier, or already-completed subset",
    );
    expect(renderGoalPrompt("continuation", goal)).toContain("Verification scope = claim scope");
    expect(renderGoalPrompt("budget-limit", goal)).toContain("NEVER start new substantive work");
  });

  test("interview prompt pins the five elements and rejects vague goals", () => {
    const text = renderInterviewPrompt("speed up the parser");
    expect(text).toContain("<rough-goal>");
    expect(text).toContain("speed up the parser");
    expect(text).toContain("Binary/deterministic success criteria");
    expect(text).toContain("Attempt cap");
    expect(text).toContain("Scope boundaries");
    expect(text).toContain("Stop/escalation conditions");
    expect(text).toContain('op:"create"');
    const bare = renderInterviewPrompt();
    expect(bare).toContain("ask what the user wants to achieve");
    expect(bare).not.toContain("<rough-goal>");
  });
});
