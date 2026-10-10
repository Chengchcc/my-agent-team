import { describe, expect, test } from "bun:test";
import { topoSort } from "./graph.js";
import { parseWorkflow, WorkflowParseError } from "./parse.js";

const base = {
  version: 1,
  id: "wf",
  nodes: [
    { id: "start", type: "start" },
    { id: "done", type: "end", status: "success" },
  ],
  edges: [{ from: "start", to: "done" }],
};

describe("parseWorkflow", () => {
  test("valid minimal", () => {
    const def = parseWorkflow(base);
    expect(def.id).toBe("wf");
    expect(def.nodes).toHaveLength(2);
  });

  test("rejects unknown node type", () => {
    expect(() => parseWorkflow({ ...base, nodes: [{ id: "x", type: "mystery" }] })).toThrow(
      WorkflowParseError,
    );
  });

  test("rejects duplicate ids", () => {
    expect(() =>
      parseWorkflow({
        ...base,
        nodes: [...base.nodes, { id: "start", type: "script", code: "x" }],
      }),
    ).toThrow(/duplicate node id/);
  });

  test("rejects agent without agentId or model+prompt", () => {
    expect(() =>
      parseWorkflow({ ...base, nodes: [...base.nodes, { id: "a", type: "agent" }] }),
    ).toThrow(/agent requires/);
  });

  test("rejects edge to unknown node", () => {
    expect(() => parseWorkflow({ ...base, edges: [{ from: "start", to: "nope" }] })).toThrow(
      /not a node id/,
    );
  });

  test("rejects cycle", () => {
    expect(() =>
      parseWorkflow({
        ...base,
        edges: [
          { from: "start", to: "done" },
          { from: "done", to: "start" },
        ],
      }),
    ).toThrow(/cycle/);
  });

  test("rejects unknown JSON-Logic operator in edge when (M2)", () => {
    // `equals` is not in OPS: pre-M2 the evaluator treated it as a truthy
    // data object and the gate routed unconditionally.
    expect(() =>
      parseWorkflow({
        ...base,
        edges: [{ from: "start", to: "done", when: { equals: [1, 1] } }],
      }),
    ).toThrow(/unknown JSON-Logic operator "equals"/);
  });

  test("normalizes valid agent, script runtime and human", () => {
    const def = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "a", type: "agent", agentId: "ag-1" },
        { id: "s", type: "script", code: "x", runtime: "bun" },
        {
          id: "h",
          type: "human",
          question: "ok?",
          form: { level: { type: "enum", options: ["a", "b"] } },
        },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "s" },
        { from: "s", to: "h" },
        { from: "h", to: "done" },
      ],
    });
    expect(def.nodes[1]).toMatchObject({ type: "agent", agentId: "ag-1" });
    expect(def.nodes[2]).toMatchObject({ type: "script", code: "x", runtime: "bun" });
    expect(def.nodes[3]).toMatchObject({
      type: "human",
      form: { level: { type: "enum", options: ["a", "b"] } },
    });
  });

  test("flags a node not reachable from start (dangling)", () => {
    expect(() =>
      parseWorkflow({
        version: 1,
        id: "wf",
        nodes: [
          { id: "start", type: "start" },
          { id: "a", type: "script", code: "x" },
          { id: "orphan", type: "script", code: "y" },
          { id: "done", type: "end", status: "success" },
        ],
        edges: [
          { from: "start", to: "a" },
          { from: "a", to: "done" },
        ],
      }),
    ).toThrow(/orphan.*not reachable from start/);
  });

  test("flags an edge when referencing a non-existent output field", () => {
    expect(() =>
      parseWorkflow({
        version: 1,
        id: "wf",
        nodes: [
          { id: "start", type: "start" },
          {
            id: "h",
            type: "human",
            form: { action: { type: "enum", options: ["yes", "no"] } },
          },
          { id: "done", type: "end", status: "success" },
        ],
        edges: [
          { from: "start", to: "h" },
          { from: "h", to: "done", when: { "==": [{ var: "h.output.actionn" }, "yes"] } },
        ],
      }),
    ).toThrow(/h.output.actionn.*no output field/);
  });

  test("accepts a human gate edge that references a real form field", () => {
    const def = parseWorkflow({
      version: 1,
      id: "wf",
      nodes: [
        { id: "start", type: "start" },
        { id: "h", type: "human", form: { action: { type: "enum", options: ["yes", "no"] } } },
        { id: "done", type: "end", status: "success" },
      ],
      edges: [
        { from: "start", to: "h" },
        { from: "h", to: "done", when: { "==": [{ var: "h.output.action" }, "yes"] } },
      ],
    });
    expect(def.edges).toHaveLength(2);
  });
});

/** ADR 0042 P1: rework is a declared, budgeted edge — never a cycle. */
describe("rework edges", () => {
  const rework = (edge: Record<string, unknown>) => ({
    version: 1,
    id: "wf",
    nodes: [
      { id: "start", type: "start" },
      { id: "build", type: "script", code: "return {}" },
      { id: "review", type: "script", code: "return {}" },
      { id: "done", type: "end", status: "success" },
    ],
    edges: [
      { from: "start", to: "build" },
      { from: "build", to: "review" },
      { from: "review", to: "done" },
      edge,
    ],
  });
  const budgeted = {
    from: "review",
    to: "build",
    kind: "rework",
    budget: { maxAttempts: 3, onExhausted: "human" },
  };

  test("a budgeted rework edge parses, and the backward edge is not a cycle", () => {
    const def = parseWorkflow(rework(budgeted));
    expect(def.edges.at(-1)).toMatchObject({
      kind: "rework",
      budget: { maxAttempts: 3, onExhausted: "human" },
    });
    // Four nodes, one start: the forward walk orders them without tripping
    // GraphCycleError, which the same edge would do without its kind.
    expect(topoSort(def)).toHaveLength(4);
  });

  test("rejects a rework edge without a budget", () => {
    expect(() => parseWorkflow(rework({ from: "review", to: "build", kind: "rework" }))).toThrow(
      /must declare budget/,
    );
  });

  test("rejects a budget on a forward edge", () => {
    expect(() =>
      parseWorkflow(
        rework({ from: "review", to: "done", budget: { maxAttempts: 2, onExhausted: "fail" } }),
      ),
    ).toThrow(/only meaningful on a rework edge/);
  });

  test("rejects a rework edge that points downstream", () => {
    expect(() =>
      parseWorkflow(
        rework({
          from: "build",
          to: "review",
          kind: "rework",
          budget: { maxAttempts: 2, onExhausted: "fail" },
        }),
      ),
    ).toThrow(/must point upstream/);
  });

  test("rejects an unknown kind", () => {
    expect(() => parseWorkflow(rework({ ...budgeted, kind: "sideways" }))).toThrow(
      /kind must be "forward" or "rework"/,
    );
  });

  test("rejects a budget that cannot grant an attempt", () => {
    expect(() =>
      parseWorkflow(rework({ ...budgeted, budget: { maxAttempts: 0, onExhausted: "fail" } })),
    ).toThrow(/maxAttempts must be a positive integer/);
  });

  test("rejects an unknown exhaustion policy", () => {
    expect(() =>
      parseWorkflow(rework({ ...budgeted, budget: { maxAttempts: 2, onExhausted: "wait" } })),
    ).toThrow(/"fail" or "human"/);
  });
});
