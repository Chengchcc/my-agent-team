import { describe, expect, test } from "bun:test";
import {
  classifyAuthorization,
  countLedgerSources,
  deriveLedgerRows,
  type LedgerRun,
} from "./authority-ledger";

function run(
  runId: string,
  authorization: string | null,
  parentRunId: string | null = null,
): LedgerRun {
  return {
    runId,
    conversationId: `c-${runId}`,
    agentId: "coder",
    status: "completed",
    createdAt: 1,
    authorization,
    parentRunId,
  };
}

describe("classifyAuthorization", () => {
  test("the five channels a run can be started under", () => {
    expect(classifyAuthorization("user").source).toBe("human");
    expect(classifyAuthorization("system").source).toBe("owner");
    expect(classifyAuthorization("ambient:standup")).toEqual({
      source: "owner",
      ruleId: "standup",
      refId: null,
    });
    expect(classifyAuthorization("ambient:assessment").ruleId).toBe("assessment");
    expect(classifyAuthorization("dispatch:r1")).toEqual({
      source: "dispatch",
      ruleId: null,
      refId: "r1",
    });
    expect(classifyAuthorization("result:coder")).toEqual({
      source: "result",
      ruleId: null,
      refId: "coder",
    });
    expect(classifyAuthorization("handback:r9").refId).toBe("r9");
  });

  test("a run with no basis, or one nobody knows, is unrecorded — never a guess", () => {
    expect(classifyAuthorization(null).source).toBe("unrecorded");
    expect(classifyAuthorization("").source).toBe("unrecorded");
    expect(classifyAuthorization("sudo").source).toBe("unrecorded");
  });
});

describe("deriveLedgerRows", () => {
  test("a dispatch chain reads run → parent run → the root's basis", () => {
    const rows = deriveLedgerRows([
      run("r3", "dispatch:r2", "r2"),
      run("r2", "dispatch:r1", "r1"),
      run("r1", "user"),
    ]);
    const leaf = rows.find((row) => row.runId === "r3");
    expect(leaf?.source).toBe("dispatch");
    expect(leaf?.chain.map((step) => [step.runId, step.source])).toEqual([
      ["r3", "dispatch"],
      ["r2", "dispatch"],
      ["r1", "human"],
    ]);
    expect(leaf?.chainBroken).toBeFalsy();
    expect(rows.find((row) => row.runId === "r1")?.chain).toHaveLength(1);
  });

  test("a parent outside the loaded rows stops the chain and says so", () => {
    const orphan = deriveLedgerRows([run("r4", "dispatch:old", "old")])[0];
    if (orphan === undefined) throw new Error("the row is missing");
    expect(orphan.chain.map((step) => step.runId)).toEqual(["r4"]);
    expect(orphan.chainBroken).toBeTruthy();
  });

  test("a dispatch whose parent column is empty follows the id in its basis", () => {
    const child = deriveLedgerRows([run("r5", "dispatch:r1"), run("r1", "user")])[0];
    if (child === undefined) throw new Error("the row is missing");
    expect(child.chain.map((step) => step.runId)).toEqual(["r5", "r1"]);
    expect(child.chainBroken).toBeFalsy();
  });

  test("a handback names the run it refused, which is not a parent", () => {
    const refusal = deriveLedgerRows([run("r6", "handback:r1"), run("r1", "user")])[0];
    if (refusal === undefined) throw new Error("the row is missing");
    expect(refusal.source).toBe("handback");
    expect(refusal.refusedRunId).toBe("r1");
    expect(refusal.chain.map((step) => step.runId)).toEqual(["r6"]);
  });

  test("a row that names itself in a loop is folded, not walked forever", () => {
    const rows = deriveLedgerRows([run("a", "dispatch:b", "b"), run("b", "dispatch:a", "a")]);
    for (const row of rows) {
      expect(row.chain.length).toBeLessThanOrEqual(2);
      expect(row.chainBroken).toBeTruthy();
    }
  });

  test("the filter counts add up to the rows", () => {
    const rows = deriveLedgerRows([
      run("h", "user"),
      run("d", "dispatch:h", "h"),
      run("r", "ambient:standup"),
      run("s", "system"),
      run("n", null),
    ]);
    const counts = countLedgerSources(rows);
    expect(counts).toEqual({
      owner: 2,
      human: 1,
      dispatch: 1,
      result: 0,
      handback: 0,
      unrecorded: 1,
    });
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    expect(total).toBe(rows.length);
  });
});
