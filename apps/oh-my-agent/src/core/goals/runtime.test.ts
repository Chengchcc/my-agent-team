import { describe, expect, test } from "bun:test";
import { GoalRuntime } from "./runtime.js";
import { createGoal } from "./state.js";

function runtimeWith(over: Partial<{ budget: number | undefined }> = {}) {
  const persisted: unknown[] = [];
  const notices: string[] = [];
  const rt = new GoalRuntime(
    (state) => persisted.push(state),
    (message) => notices.push(message),
  );
  rt.create("make tests pass", over.budget);
  return { rt, persisted, notices };
}

const turn = (over: Partial<Parameters<GoalRuntime["settleTurn"]>[0]> = {}) => ({
  usage: { inputTokens: 10, outputTokens: 5 },
  wallSeconds: 2,
  status: "completed" as const,
  usedTools: true,
  ...over,
});

describe("GoalRuntime accounting and decisions (omp port)", () => {
  test("every transition persists, so a quit right after the command survives", () => {
    const { rt, persisted } = runtimeWith();
    expect(persisted).toHaveLength(1); // create
    rt.pause();
    rt.resume();
    rt.drop();
    expect(persisted).toHaveLength(4);
    expect(persisted.at(-1)).toBeNull(); // drop clears the replay
  });

  test("complete folds the settled turn into the report (omp flush-before-complete)", () => {
    const { rt } = runtimeWith({ budget: 1000 });
    expect(rt.goal?.status).toBe("active");
    rt.complete();
    // The tool fired mid-run: usage lands at settle time.
    const decision = rt.settleTurn(turn({ usage: { inputTokens: 400, outputTokens: 100 } }));
    expect(decision.action).toBe("completed");
    if (decision.action !== "completed") return;
    expect(rt.goal?.tokensUsed).toBe(500);
    expect(decision.report).toContain("500 of 1000");
  });

  test("an interrupted turn PAUSES and never queues work", () => {
    const { rt } = runtimeWith({ budget: 100 }); // budget would cross this turn
    const decision = rt.settleTurn(turn({ status: "aborted", usage: { inputTokens: 500 } }));
    expect(decision.action).toBe("paused");
    expect(rt.state?.enabled).toBe(false);
    expect(rt.goal?.status).toBe("paused");
  });

  test("budget crossing wraps up exactly once; later turns go idle", () => {
    const { rt } = runtimeWith({ budget: 12 });
    const first = rt.settleTurn(turn()); // 15 ≥ 12
    expect(first.action).toBe("budget-wrapup");
    expect(rt.goal?.status).toBe("budget-limited");
    const second = rt.settleTurn(turn());
    expect(second.action).toBe("idle");
  });

  test("raising the budget resumes a budget-limited goal (omp onBudgetMutated)", () => {
    const { rt } = runtimeWith({ budget: 12 });
    rt.settleTurn(turn());
    expect(rt.goal?.status).toBe("budget-limited");
    const resumed = rt.setBudget(10_000);
    expect(resumed?.prompt).toContain("<objective>");
    expect(rt.goal?.status).toBe("active");
    // Lowering it back below tokensUsed re-limits without a continuation.
    expect(rt.setBudget(5)).toBeNull();
    expect(rt.goal?.status).toBe("budget-limited");
  });

  test("stall backstop: three toolless turns pause the goal", () => {
    const { rt } = runtimeWith();
    expect(rt.settleTurn(turn({ usedTools: false })).action).toBe("continue");
    expect(rt.settleTurn(turn({ usedTools: false })).action).toBe("continue");
    const third = rt.settleTurn(turn({ usedTools: false }));
    expect(third.action).toBe("paused");
    if (third.action === "paused") expect(third.reason).toContain("without tool use");
    // Progress resets the counter.
    const fresh = runtimeWith();
    fresh.rt.settleTurn(turn({ usedTools: false }));
    fresh.rt.settleTurn(turn({ usedTools: true }));
    expect(fresh.rt.settleTurn(turn({ usedTools: false })).action).toBe("continue");
  });

  test("interview mounts the tool but has no goal; create clears it", () => {
    const rt = new GoalRuntime();
    expect(rt.toolWanted).toBe(false);
    rt.beginInterview();
    expect(rt.toolWanted).toBe(true);
    expect(rt.goal).toBeNull();
    rt.create("objective from interview");
    expect(rt.interviewing).toBe(false);
    expect(rt.toolWanted).toBe(true);
    expect(rt.goal?.objective).toBe("objective from interview");
  });

  test("restore replays a persisted live goal as paused (never auto-resume)", () => {
    const rt = new GoalRuntime();
    rt.restore(createGoal("resumed session goal", 500));
    // The TUI converts live goals to paused before restoring; the runtime
    // must not queue continuations for a goal nobody resumed.
    rt.restore({
      enabled: false,
      mode: "active",
      goal: { ...createGoal("g").goal, status: "paused" },
    });
    expect(rt.settleTurn(turn()).action).toBe("idle");
  });

  test("no goal → idle; remainingTokens tracks the budget", () => {
    const bare = new GoalRuntime();
    expect(bare.settleTurn(turn()).action).toBe("idle");
    expect(bare.remainingTokens()).toBeNull();
    expect(bare.setBudget(5)).toBeNull(); // no goal: no-op
    const { rt } = runtimeWith({ budget: 30 });
    expect(rt.remainingTokens()).toBe(30);
    rt.settleTurn(turn());
    expect(rt.remainingTokens()).toBe(15);
  });

  test("todo context (omp goal-todo-context): counts + rows, empty → no block", () => {
    expect(GoalRuntime.renderTodoContext([])).toBe("");
    const ctx = GoalRuntime.renderTodoContext([
      { id: "1", text: "wire the loop", status: "in_progress" },
      { id: "2", text: "write tests", status: "pending" },
      { id: "3", text: "read the docs", status: "done" },
    ]);
    expect(ctx).toContain("<todo_context>");
    expect(ctx).toContain("Overall: 1/3 done, 2 open.");
    expect(ctx).toContain("[in_progress] wire the loop");
    // The load-bearing instruction: no visible nudge means stale items rot.
    expect(ctx).toContain("call `todo` first");
    // Cancelled items count as closed, like done.
    const withCancelled = GoalRuntime.renderTodoContext([
      { id: "1", text: "dropped idea", status: "cancelled" },
      { id: "2", text: "keep going", status: "pending" },
    ]);
    expect(withCancelled).toContain("Overall: 1/2 done, 1 open.");
  });

  test("complete without a goal throws; unknown ops never corrupt state", () => {
    const rt = new GoalRuntime();
    expect(() => rt.complete()).toThrow(/no goal/);
    expect(rt.setBudget(100)).toBeNull();
    expect(rt.state).toBeNull();
  });
});
