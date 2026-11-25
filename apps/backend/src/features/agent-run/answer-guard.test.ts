import { describe, expect, test } from "bun:test";
import { answerRefusal, beyondFrozenScope } from "./answer-guard.js";

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

describe("a request beyond the frozen scope", () => {
  const scope = {
    toolPolicy: {
      deny: [],
      allow: ["/work/project/"],
      denyCommands: ["git push", "rm -rf"],
    },
  };

  test("a denied command is out of scope", () => {
    const why = beyondFrozenScope({ input: { command: "git push origin main" } }, scope);
    expect(why).toContain("git push");
  });

  test("a write outside the allowed paths is out of scope", () => {
    const why = beyondFrozenScope({ input: { path: "/etc/passwd" } }, scope);
    expect(why).toContain("/etc/passwd");
  });

  test("inside the frozen scope passes", () => {
    expect(
      beyondFrozenScope({ input: { path: "/work/project/src/a.ts", command: "npm test" } }, scope),
    ).toBeUndefined();
  });

  test("no frozen policy is not treated as out of scope", () => {
    expect(
      beyondFrozenScope({ input: { command: "rm -rf /" } }, { toolPolicy: null }),
    ).toBeUndefined();
  });

  test("the marked request is the person's to answer", () => {
    const marked = {
      actionId: "a",
      status: "pending",
      owner: "user",
      payload: { risk: { beyondScope: true } },
    };
    expect(answerRefusal(marked, "front")).toContain("beyond the scope");
  });
});
