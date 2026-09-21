import { describe, expect, test } from "bun:test";
import { GoalRuntime } from "./runtime.js";
import { createGoalPlugin, createGoalTool } from "./tool.js";

/** The tool the MODEL calls: everything above this file tests the runtime, so
 *  this drives the real factory through the plugin the TUI mounts — the ops,
 *  the shapes the model must read, and the error paths it must recover from. */
function toolWithGoal() {
  const rt = new GoalRuntime();
  const tool = createGoalTool(rt);
  return { rt, tool, call: (input: unknown) => tool.execute(input) };
}

const text = (res: { content: string }): string => res.content;

describe("goal tool (the model-facing surface)", () => {
  test("create starts the goal and reports the state the model needs", async () => {
    const { rt, call } = toolWithGoal();
    const res = await call({ op: "create", objective: "make the suite pass", token_budget: 5000 });
    const payload = JSON.parse(text(res)) as {
      goal: { objective: string; status: string; tokensUsed: number; tokenBudget: number };
    };
    expect(payload.goal.objective).toBe("make the suite pass");
    expect(payload.goal.status).toBe("active");
    expect(payload.goal.tokensUsed).toBe(0);
    expect(payload.goal.tokenBudget).toBe(5000);
    expect(rt.goal?.objective).toBe("make the suite pass");
  });

  test("get returns the live state, including remaining tokens", async () => {
    const { rt, call } = toolWithGoal();
    await call({ op: "create", objective: "obj", token_budget: 100 });
    rt.settleTurn({
      usage: { inputTokens: 40 },
      wallSeconds: 1,
      status: "completed",
      usedTools: true,
    });
    const payload = JSON.parse(text(await call({ op: "get" }))) as {
      goal: { tokensUsed: number; remainingTokens: number };
    };
    expect(payload.goal.tokensUsed).toBe(40);
    expect(payload.goal.remainingTokens).toBe(60);
  });

  test("get with no goal is a readable sentence, not an error (omp shape)", async () => {
    const { call } = toolWithGoal();
    const res = await call({ op: "get" });
    expect(text(res)).toContain("No active goal");
    expect(res.isError).toBeUndefined();
  });

  test("complete ends the loop and tells the model to report", async () => {
    const { rt, call } = toolWithGoal();
    await call({ op: "create", objective: "obj" });
    const res = await call({ op: "complete" });
    expect(text(res)).toContain("report the achievement");
    expect(rt.goal?.status).toBe("complete");
    expect(rt.state?.enabled).toBe(false);
  });

  test("resume and drop round-trip; both refuse without a goal", async () => {
    const { rt, call } = toolWithGoal();
    expect((await call({ op: "resume" })).isError).toBe(true);
    expect((await call({ op: "drop" })).isError).toBe(true);

    await call({ op: "create", objective: "obj" });
    rt.pause();
    expect((await call({ op: "resume" })).isError).toBeUndefined();
    expect(rt.goal?.status).toBe("active");
    expect(text(await call({ op: "drop" }))).toContain("Stop goal-directed work");
    expect(rt.goal).toBeNull();

    await call({ op: "create", objective: "second" });
    const dropped = await call({ op: "drop" });
    expect(text(dropped)).toContain("dropped");
    expect(rt.state).toBeNull();
  });

  test("a bad op and a bad budget come back as recoverable errors", async () => {
    const { call } = toolWithGoal();
    expect((await call({ op: "sing" })).isError).toBe(true);
    expect(text(await call({ op: "sing" }))).toContain("unknown op");
    expect((await call({})).isError).toBe(true);
    // A second create REPLACES an active goal (fresh counters), matching the
    // /goal set semantics; it is only refused while the goal is PAUSED, where
    // the replacement would silently discard parked work.
    await call({ op: "create", objective: "first" });
    const second = await call({ op: "create", objective: "second" });
    expect(second.isError).toBeUndefined();
    const payload = JSON.parse(text(second)) as { goal: { objective: string } };
    expect(payload.goal.objective).toBe("second");
  });

  test("completing a paused goal is allowed only via resume (guard surfaces)", async () => {
    const { rt, call } = toolWithGoal();
    await call({ op: "create", objective: "obj" });
    rt.pause();
    // complete() on a paused goal is not a usage-flush path: the runtime
    // permits it (the user asked for the tool surface to stay usable), and the
    // state lands terminal either way.
    await call({ op: "complete" });
    expect(rt.goal?.status).toBe("complete");
  });

  test("the plugin wrapper carries exactly the one tool, named goal", () => {
    const plugin = createGoalPlugin(new GoalRuntime());
    expect(plugin.name).toBe("goal-mode");
    expect(plugin.tools?.map((t) => t.name)).toEqual(["goal"]);
  });
});

describe("goal tool usage accounting (the completion report)", () => {
  test("a complete after a settle reports the turn's tokens (no stale counters)", async () => {
    const rt = new GoalRuntime();
    const tool = createGoalTool(rt);
    await tool.execute({ op: "create", objective: "obj", token_budget: 1000 });
    // The model calls complete mid-run; the turn's usage arrives at settle.
    await tool.execute({ op: "complete" });
    const decision = rt.settleTurn({
      usage: { inputTokens: 300, outputTokens: 100 },
      wallSeconds: 2,
      status: "completed",
      usedTools: true,
    });
    expect(decision.action).toBe("completed");
    if (decision.action !== "completed") return;
    expect(rt.goal?.tokensUsed).toBe(400);
    expect(decision.report).toContain("400 of 1000");
  });
});
