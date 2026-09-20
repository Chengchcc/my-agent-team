import { describe, expect, test } from "bun:test";
import type { AIMessageChunk } from "@chengchenccc/message";
import {
  buildGoalMessages,
  DEFAULT_GOAL_MAX_TURNS,
  decideGoalCycle,
  evaluateGoal,
  type GoalEvaluation,
  goalEvaluatorModelId,
  goalMaxTurns,
  isGoalError,
  parseGoalVerdict,
} from "./goal-evaluator.js";

const metEvaluation: GoalEvaluation = { verdict: "met" };

function facts(over: Partial<Parameters<typeof decideGoalCycle>[0]> = {}) {
  return {
    verdict: metEvaluation,
    turns: 1,
    maxTurns: DEFAULT_GOAL_MAX_TURNS,
    noProgressRuns: 0,
    runHadTools: true,
    runStatus: "completed",
    runningBgJobs: 0,
    ...over,
  };
}

describe("goal evaluator parsing", () => {
  test("all three verdicts parse, fenced JSON tolerated", () => {
    expect(parseGoalVerdict('{"verdict":"met"}')).toEqual({ verdict: "met" });
    expect(parseGoalVerdict('```json\n{"verdict":"not_yet","reason":"2 tests left"}\n```')).toEqual(
      { verdict: "not_yet", reason: "2 tests left" },
    );
    expect(parseGoalVerdict('{"verdict":"impossible","reason":"no access"}')).toEqual({
      verdict: "impossible",
      reason: "no access",
    });
  });

  test("garbage is an ERROR, never a not_yet — a broken evaluator must not spin the loop", () => {
    expect(isGoalError(parseGoalVerdict("all done!"))).toBe(true);
    expect(isGoalError(parseGoalVerdict('{"verdict":"maybe"}'))).toBe(true);
    expect(isGoalError(parseGoalVerdict(""))).toBe(true);
  });

  test("knobs: model id trims, turn cap validates", () => {
    expect(goalEvaluatorModelId({ OMA_GOAL_MODEL: " fake/echo " })).toBe("fake/echo");
    expect(goalEvaluatorModelId({})).toBeUndefined();
    expect(goalMaxTurns({ OMA_GOAL_MAX_TURNS: "3" })).toBe(3);
    expect(goalMaxTurns({ OMA_GOAL_MAX_TURNS: "abc" })).toBe(DEFAULT_GOAL_MAX_TURNS);
    expect(goalMaxTurns({ OMA_GOAL_MAX_TURNS: "0" })).toBe(DEFAULT_GOAL_MAX_TURNS);
  });

  test("messages carry the condition and evidence, verdict-only contract", () => {
    const messages = buildGoalMessages("tests pass", ["user: fix it", "tool bash: ok"]);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.text).toContain("tests pass");
    expect(messages[1]!.text).toContain("tool bash: ok");
  });

  test("evaluateGoal: streams text deltas into a verdict; errors never throw", async () => {
    const textStream = (text: string) =>
      async function* (): AsyncIterable<AIMessageChunk> {
        yield { delta: { type: "text", text } } as AIMessageChunk;
      };
    expect(
      await evaluateGoal({
        condition: "c",
        evidence: [],
        stream: () => textStream('{"verdict":"met"}')(),
      }),
    ).toEqual({ verdict: "met" });
    const failing = async function* (): AsyncIterable<AIMessageChunk> {
      throw new Error("provider down");
    };
    const result = await evaluateGoal({ condition: "c", evidence: [], stream: () => failing() });
    expect(isGoalError(result)).toBe(true);
  });
});

describe("decideGoalCycle (the loop's contract)", () => {
  test("met / impossible stop with reasons", () => {
    expect(decideGoalCycle(facts({ verdict: { verdict: "met" } }))).toEqual({
      action: "stop",
      reason: "goal met after 1 turn(s)",
    });
    expect(
      decideGoalCycle(facts({ verdict: { verdict: "impossible", reason: "no repo access" } })),
    ).toEqual({ action: "stop", reason: "goal impossible: no repo access" });
  });

  test("not_yet continues with the evaluator's guidance", () => {
    const decision = decideGoalCycle(
      facts({ verdict: { verdict: "not_yet", reason: "lint left" } }),
    );
    expect(decision.action).toBe("continue");
    if (decision.action === "continue") expect(decision.guidance).toBe("lint left");
  });

  test("fail-safe ordering: failed run and evaluator errors stop FIRST", () => {
    expect(
      decideGoalCycle(facts({ runStatus: "failed", verdict: { verdict: "not_yet" } })).action,
    ).toBe("stop");
    expect(decideGoalCycle(facts({ verdict: { error: "evaluator down" } })).action).toBe("stop");
  });

  test("background work defers (their settlement wakes the goal)", () => {
    expect(
      decideGoalCycle(facts({ runningBgJobs: 2, verdict: { verdict: "not_yet" } })).action,
    ).toBe("wait");
  });

  test("caps: turn cap and no-progress stall stop the loop", () => {
    expect(
      decideGoalCycle(facts({ turns: 5, maxTurns: 5, verdict: { verdict: "not_yet" } })).action,
    ).toBe("stop");
    expect(
      decideGoalCycle(
        facts({ noProgressRuns: 3, runHadTools: false, verdict: { verdict: "not_yet" } }),
      ).action,
    ).toBe("stop");
    // Progress resets the stall counter below the limit.
    expect(
      decideGoalCycle(
        facts({ noProgressRuns: 2, runHadTools: true, verdict: { verdict: "not_yet" } }),
      ).action,
    ).toBe("continue");
  });
});
