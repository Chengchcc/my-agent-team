import { describe, expect, test } from "bun:test";
import { parseWorkflow } from "./parse.js";
import { budgetGateNodeId, deriveRework, planRework, reworkInputOf } from "./rework.js";

/** start → build → review → done, with review able to send build back. */
const def = parseWorkflow({
  version: 1,
  id: "wf",
  nodes: [
    { id: "start", type: "start" },
    { id: "build", type: "script", code: "x", output: [{ key: "artifact", type: "string" }] },
    { id: "review", type: "script", code: "x", output: [{ key: "feedback", type: "string" }] },
    { id: "done", type: "end", status: "success" },
  ],
  edges: [
    { from: "start", to: "build" },
    { from: "build", to: "review" },
    { from: "review", to: "done" },
    {
      from: "review",
      to: "build",
      kind: "rework",
      budget: { maxAttempts: 2, onExhausted: "human" },
      when: { "==": [{ var: "review.output.feedback" }, "redo"] },
    },
  ],
});

const plan = (
  sourceOutput: Record<string, unknown>,
  attempts: Record<string, number> = { build: 1 },
) => planRework({ def, from: "review", sourceOutput, attempts, store: {} });

/** The same graph with an unconditional rework edge: the reason and clipping
 *  cases need a grant, not a verdict. */
const defNoWhen = parseWorkflow({
  version: 1,
  id: "wf",
  nodes: [
    { id: "start", type: "start" },
    { id: "build", type: "script", code: "x" },
    { id: "review", type: "script", code: "x" },
    { id: "done", type: "end", status: "success" },
  ],
  edges: [
    { from: "start", to: "build" },
    { from: "build", to: "review" },
    { from: "review", to: "done" },
    {
      from: "review",
      to: "build",
      kind: "rework",
      budget: { maxAttempts: 2, onExhausted: "human" },
    },
  ],
});
const planAlways = (sourceOutput: Record<string, unknown>) =>
  planRework({ def: defNoWhen, from: "review", sourceOutput, attempts: { build: 1 }, store: {} });

describe("planRework", () => {
  test("a rejected verdict grants the next attempt and invalidates downstream", () => {
    const [grant] = plan({ feedback: "redo" });
    expect(grant).toMatchObject({
      from: "review",
      to: "build",
      attempt: 2,
      exhausted: false,
      reason: "redo",
    });
    // The target first, then everything downstream of it: after the rebuild the
    // review and its verdict are stale too, which is what re-runs them.
    expect(grant?.invalidated).toEqual(["build", "review", "done"]);
  });

  test("an accepted verdict grants nothing", () => {
    expect(plan({ feedback: "ship it" })).toEqual([]);
  });

  test("the budget verdict comes from the target's recorded attempts", () => {
    expect(plan({ feedback: "redo" }, { build: 1 })[0]?.exhausted).toBe(false);
    // maxAttempts 2: the third attempt is the one that needs a human to grant it.
    const [grant] = plan({ feedback: "redo" }, { build: 2 });
    expect(grant).toMatchObject({ attempt: 3, exhausted: true });
    expect(grant?.budget).toEqual({ maxAttempts: 2, onExhausted: "human" });
  });

  test("the reason is read from the usual verdict fields, else the output itself", () => {
    expect(planAlways({ feedback: "redo", reason: "nope" })[0]?.reason).toBe("nope");
    expect(planAlways({ error: "boom" })[0]?.reason).toBe("boom");
    expect(planAlways({ answers: [{ id: "approve", selectedValues: ["redo"] }] })[0]?.reason).toBe(
      JSON.stringify({ answers: [{ id: "approve", selectedValues: ["redo"] }] }),
    );
    expect(planAlways({})[0]?.reason).toBe("");
  });

  test("a long verdict is clipped, not carried whole into the next prompt", () => {
    const long = "x".repeat(2500);
    const reason = planAlways({ feedback: long })[0]?.reason ?? "";
    expect(reason.endsWith("…")).toBe(true);
    expect(reason.length).toBeLessThanOrEqual(2001);
  });

  test("no rework edges declared means no plan", () => {
    const plain = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [{ from: "start", to: "done" }],
    });
    expect(planRework({ def: plain, from: "start", attempts: {}, store: {} })).toEqual([]);
  });

  test("the context the next attempt receives", () => {
    const [grant] = plan({ feedback: "redo" });
    expect(reworkInputOf(grant!)).toEqual({
      attempt: 2,
      rework: { from: "review", reason: "redo" },
    });
  });
});

describe("deriveRework (the rows are the state)", () => {
  const gate = (nodeId: string, decision?: string) => ({
    nodeId: budgetGateNodeId(nodeId),
    status: "superseded",
    output: {
      budgetGate: {
        nodeId,
        from: "review",
        attempt: 3,
        maxAttempts: 2,
        reason: "redo",
      },
      ...(decision === undefined ? {} : { decision }),
    },
  });

  test("a used verdict owes the target a retry", () => {
    const derived = deriveRework(def, [
      { nodeId: "start", status: "completed" },
      { nodeId: "build", status: "superseded", output: { artifact: "v1" } },
      { nodeId: "review", status: "superseded", output: { feedback: "redo" } },
    ]);
    expect([...derived.invalidated].sort()).toEqual(["build", "review"]);
    expect(derived.grants).toHaveLength(1);
    expect(derived.grants[0]).toMatchObject({ to: "build", attempt: 2, exhausted: false, reason: "redo" });
    expect(derived.exhausted).toEqual([]);
  });

  test("nothing is owed until the verdict has been applied", () => {
    const derived = deriveRework(def, [
      { nodeId: "start", status: "completed" },
      { nodeId: "build", status: "completed" },
      { nodeId: "review", status: "completed", output: { feedback: "redo" } },
    ]);
    expect(derived.grants).toEqual([]);
    expect(derived.invalidated.size).toBe(0);
  });

  test("a target that already re-ran owes nothing", () => {
    const derived = deriveRework(def, [
      { nodeId: "start", status: "completed" },
      { nodeId: "build", status: "superseded" },
      { nodeId: "build", status: "completed", output: { artifact: "v2" } },
      { nodeId: "review", status: "superseded", output: { feedback: "redo" } },
    ]);
    expect(derived.grants).toEqual([]);
    // Not owed at all: the mutated check (source superseded alone) would put
    // this verdict in `exhausted` instead, which is the whole distinction.
    expect(derived.exhausted).toEqual([]);
    // The review is still superseded: the retry has not been re-reviewed yet,
    // so it keeps its old verdict out of the engine's "done" set.
    expect([...derived.invalidated]).toEqual(["review"]);
  });

  test("a spent budget is reported, not granted", () => {
    const derived = deriveRework(def, [
      { nodeId: "start", status: "completed" },
      { nodeId: "build", status: "superseded" },
      { nodeId: "build", status: "superseded" },
      { nodeId: "review", status: "superseded", output: { feedback: "still redo" } },
    ]);
    expect(derived.grants).toEqual([]);
    expect(derived.exhausted).toHaveLength(1);
    expect(derived.exhausted[0]).toMatchObject({ to: "build", attempt: 3, exhausted: true });
  });

  test("a human grant buys the next attempt", () => {
    const derived = deriveRework(def, [
      { nodeId: "start", status: "completed" },
      { nodeId: "build", status: "superseded" },
      { nodeId: "build", status: "superseded" },
      { nodeId: "review", status: "superseded", output: { feedback: "still redo" } },
      gate("build", "grant"),
    ]);
    expect(derived.exhausted).toEqual([]);
    expect(derived.grants[0]).toMatchObject({ to: "build", attempt: 3, exhausted: false });
  });

  test("a rejected gate grants nothing", () => {
    const derived = deriveRework(def, [
      { nodeId: "start", status: "completed" },
      { nodeId: "build", status: "superseded" },
      { nodeId: "build", status: "superseded" },
      { nodeId: "review", status: "superseded", output: { feedback: "still redo" } },
      gate("build", "reject"),
    ]);
    expect(derived.grants).toEqual([]);
    expect(derived.exhausted).toHaveLength(1);
  });
});
