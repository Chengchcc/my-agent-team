import { describe, expect, test } from "bun:test";
import type { WorkflowDefinitionRow } from "@/lib/api";
import { definitionFacts } from "./definition-facts";
import {
  isRunning,
  runBlockReason,
  runFact,
  triggerState,
  type WorkflowCard,
  workflowCard,
  workflowDescription,
  workflowName,
} from "./list-facts";
import type { WorkflowExec } from "./queries";

const definition = {
  version: 1,
  id: "nightly-lint",
  meta: { name: "Nightly lint", description: "Check the wiki" },
  triggers: [{ type: "cron", cron: "0 4 * * *", enabled: false }],
  nodes: [
    { id: "start", type: "start" },
    { id: "check", type: "script", code: "echo hi" },
    { id: "done", type: "end", status: "success" },
  ],
  edges: [
    { from: "start", to: "check" },
    { from: "check", to: "done" },
  ],
};

function rowOf(overrides: Partial<WorkflowDefinitionRow>): WorkflowDefinitionRow {
  const row: WorkflowDefinitionRow = {
    workflowId: "nightly-lint",
    updatedAt: 1_000,
    valid: true,
    scriptNodesBlocked: false,
    ...overrides,
  };
  return row;
}

function execOf(
  executionId: string,
  status: string,
  times: { createdAt: number; terminalAt?: number },
): WorkflowExec {
  const execution: WorkflowExec = { executionId, status, createdAt: times.createdAt };
  if (times.terminalAt !== undefined) execution.terminalAt = times.terminalAt;
  return execution;
}

function cardOf(row: WorkflowDefinitionRow): WorkflowCard {
  const base = workflowCard(row, definition, []);
  return { ...base, row };
}

describe("runFact", () => {
  test("states when a run started, how long it took, and what started it", () => {
    expect(runFact(execOf("e1", "success", { createdAt: 1_000, terminalAt: 61_499 }))).toEqual({
      executionId: "e1",
      status: "success",
      startedAt: 1_000,
      durationSec: 60,
      triggeredBy: null,
    });
    const scheduled: WorkflowExec = {
      executionId: "e2",
      status: "running",
      createdAt: 5,
      triggeredBy: "cron:0 4 * * *",
    };
    expect(runFact(scheduled).triggeredBy).toBe("cron:0 4 * * *");
  });

  test("has no duration for a run that has not ended, and never a negative one", () => {
    expect(runFact(execOf("e1", "running", { createdAt: 10 })).durationSec).toBeNull();
    expect(runFact(execOf("e1", "failure", { createdAt: 50, terminalAt: 40 })).durationSec).toBe(0);
  });
});

describe("isRunning", () => {
  test("counts only a running execution; one waiting for a person does not block", () => {
    expect(isRunning([])).toBeFalsy();
    expect(isRunning([{ status: "waiting_human" }, { status: "success" }])).toBeFalsy();
    expect(isRunning([{ status: "success" }, { status: "running" }])).toBeTruthy();
  });
});

describe("workflowCard", () => {
  test("reads the definition and counts the runs, the newest being the last run", () => {
    const card = workflowCard(rowOf({}), definition, [
      execOf("new", "failure", { createdAt: 1_700_000_300_000, terminalAt: 1_700_000_320_000 }),
      execOf("old", "success", { createdAt: 1_700_000_100_000, terminalAt: 1_700_000_110_000 }),
    ]);
    expect(card.facts?.nodeCount).toBe(3);
    expect(card.facts?.edgeCount).toBe(2);
    expect(card.preview?.nodes).toHaveLength(3);
    expect(card.preview?.edges).toEqual([
      { from: "start", to: "check", rework: false },
      { from: "check", to: "done", rework: false },
    ]);
    expect(card.executionCount).toBe(2);
    expect(card.lastRun?.executionId).toBe("new");
    expect(card.lastRun?.durationSec).toBe(20);
    expect(card.running).toBeFalsy();
  });

  test("a definition that could not be read is no fact, not a guess", () => {
    const card = workflowCard(rowOf({ valid: false }), null, [
      execOf("e", "running", { createdAt: 1 }),
    ]);
    expect(card.facts).toBeNull();
    expect(card.preview).toBeNull();
    expect(card.running).toBeTruthy();
  });
});

describe("runBlockReason", () => {
  test("closes Run for scripts this server will not run, before any other reason", () => {
    const blocked = workflowCard(rowOf({ scriptNodesBlocked: true, valid: false }), definition, [
      execOf("e", "running", { createdAt: 1 }),
    ]);
    expect(runBlockReason(blocked)).toBe("scripts");
  });

  test("closes Run for a definition the server or the parser refuses", () => {
    expect(runBlockReason(cardOf(rowOf({ valid: false })))).toBe("invalid");
    const broken = { ...definition, nodes: "not a list" };
    expect(runBlockReason(workflowCard(rowOf({}), broken, []))).toBe("invalid");
  });

  test("closes Run while an execution is going, and opens it otherwise", () => {
    const going = workflowCard(rowOf({}), definition, [execOf("e", "running", { createdAt: 1 })]);
    expect(runBlockReason(going)).toBe("running");
    const waiting = workflowCard(rowOf({}), definition, [
      execOf("e", "waiting_human", { createdAt: 1 }),
    ]);
    expect(runBlockReason(waiting)).toBeNull();
    expect(runBlockReason(cardOf(rowOf({})))).toBeNull();
  });
});

describe("triggerState", () => {
  test("is manual, enabled or disabled from the saved definition", () => {
    expect(triggerState(definitionFacts(definition))).toBe("disabled");
    const on = { ...definition, triggers: [{ type: "cron", cron: "0 4 * * *" }] };
    expect(triggerState(definitionFacts(on))).toBe("enabled");
    expect(triggerState(definitionFacts({ ...definition, triggers: [] }))).toBe("manual");
  });
});

describe("names", () => {
  test("the definition's name and description win, then the row's, then the id", () => {
    const read = workflowCard(rowOf({}), definition, []);
    expect(workflowName(read)).toBe("Nightly lint");
    expect(workflowDescription(read)).toBe("Check the wiki");
    const unread = workflowCard(rowOf({ workflowId: "bare", name: "Row name" }), null, []);
    expect(workflowName(unread)).toBe("Row name");
    expect(workflowDescription(unread)).toBe("");
    const bare = workflowCard(rowOf({ workflowId: "bare" }), null, []);
    expect(workflowName(bare)).toBe("bare");
  });
});
