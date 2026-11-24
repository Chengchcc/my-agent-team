import { describe, expect, test } from "bun:test";
import {
  buildDispatchTree,
  type DispatchNode,
  type DispatchRunRow,
  MAX_DISPATCH_DEPTH,
} from "./dispatch-tree";

const run = (over: Partial<DispatchRunRow> & { runId: string }): DispatchRunRow => ({
  agentId: "worker",
  status: "completed",
  createdAt: 0,
  parentRunId: "front",
  ...over,
});

describe("ADR 0060 dispatch tree derivation", () => {
  test("children of the front desk run are grouped, oldest first", () => {
    const tree = buildDispatchTree(
      [
        run({ runId: "w2", agentId: "fe", createdAt: 20 }),
        run({ runId: "w1", agentId: "be", createdAt: 10 }),
        run({ runId: "other", parentRunId: "elsewhere" }),
      ],
      "front",
    );
    expect(tree.map((n) => n.runId)).toEqual(["w1", "w2"]);
    expect(tree.map((n) => n.agentId)).toEqual(["be", "fe"]);
  });

  test("a worker that dispatched again nests under it", () => {
    const tree = buildDispatchTree(
      [
        run({ runId: "w1", agentId: "fe" }),
        run({ runId: "w1a", agentId: "db", parentRunId: "w1" }),
      ],
      "front",
    );
    expect(tree[0]?.children.map((n) => n.runId)).toEqual(["w1a"]);
  });

  test("the depth cap folds instead of painting an unbounded chain", () => {
    // front -> a -> b -> c -> d: the UI must stop at the same depth the wake
    // guard does, so it never shows a layer the mechanism refuses to extend.
    const runs: DispatchRunRow[] = [
      run({ runId: "a" }),
      run({ runId: "b", parentRunId: "a" }),
      run({ runId: "c", parentRunId: "b" }),
      run({ runId: "d", parentRunId: "c" }),
    ];
    const tree = buildDispatchTree(runs, "front");
    const count = (nodes: readonly DispatchNode[]): number =>
      nodes.reduce((sum, n) => sum + 1 + count(n.children), 0);
    // a(1) + b(2) + c(3); d would be layer 4 and is dropped.
    expect(count(tree)).toBe(3);
    expect(MAX_DISPATCH_DEPTH).toBe(3);
  });

  test("a row that names itself as its parent cannot loop", () => {
    const tree = buildDispatchTree([run({ runId: "self", parentRunId: "self" })], "self");
    expect(tree).toEqual([]);
  });

  test("no children means the block renders nothing (not an empty shell)", () => {
    expect(buildDispatchTree([run({ runId: "w1" })], "another-front")).toEqual([]);
  });

  test("a unit carries the tracked goal its run advances", () => {
    const runs = [
      {
        runId: "r1",
        agentId: "a",
        status: "completed",
        createdAt: 1,
        parentRunId: "p",
        goal: "Fix login retry",
      },
      { runId: "r2", agentId: "a", status: "completed", createdAt: 2, parentRunId: "p" },
    ];
    const [first, second] = buildDispatchTree(runs, "p");
    expect(first!.goal).toBe("Fix login retry");
    // No requirement attached is said out loud, not filled with a guess.
    expect(second!.goal).toBeNull();
  });
});
