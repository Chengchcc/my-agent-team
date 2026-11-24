import { describe, expect, test } from "bun:test";
import { answerRefusal } from "./answer-guard.js";

const action = (
  over: Partial<{ status: string; owner: string | null; payload: Record<string, unknown> }>,
) => ({
  actionId: "run-1:call-1",
  status: over.status ?? "pending",
  owner: over.owner ?? "agent:front",
  payload: over.payload ?? {},
});

describe("who may answer a parked request", () => {
  test("the owner may answer a plain request", () => {
    expect(answerRefusal(action({}), "front")).toBeUndefined();
  });

  test("someone else may not", () => {
    expect(answerRefusal(action({ owner: "agent:other" }), "front")).toContain("not you");
  });

  test("a settled request cannot be answered twice", () => {
    expect(answerRefusal(action({ status: "resolved" }), "front")).toContain("no longer pending");
  });

  test("an irreversible request is the person's, even for its owner", () => {
    const marked = action({ payload: { risk: { irreversible: true } } });
    expect(answerRefusal(marked, "front")).toContain("irreversible");
  });

  test("an unmarked request is not treated as irreversible", () => {
    expect(
      answerRefusal(action({ payload: { risk: { irreversible: false } } }), "front"),
    ).toBeUndefined();
  });
});
