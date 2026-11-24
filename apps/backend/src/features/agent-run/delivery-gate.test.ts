import { describe, expect, test } from "bun:test";
import { type DeliveryGateRun, deliveryNoteOf, producedByEvent } from "./delivery-gate.js";

const run = (over: Partial<DeliveryGateRun> & { runId: string }): DeliveryGateRun => ({
  agentId: "worker-a",
  parentRunId: "pa-1",
  createdAt: 1000,
  terminalAt: 2000,
  status: "completed",
  ...over,
});

const gate = (runs: DeliveryGateRun[], produced: Set<string>) =>
  deliveryNoteOf({
    selfAgentId: "pa",
    runs,
    produced: (runId) => produced.has(runId),
  });

describe("the delivery gate", () => {
  test("a plain answer with no dispatch needs no second opinion", () => {
    expect(gate([], new Set())).toBeUndefined();
  });

  test("a change with no later review is flagged", () => {
    const note = gate([run({ runId: "w1" })], new Set(["w1"]));
    expect(note).toContain("未经核验");
  });

  test("a later read-only run by a different agent clears it", () => {
    const note = gate(
      [
        run({ runId: "w1" }),
        run({ runId: "w2", agentId: "worker-b", createdAt: 3000, terminalAt: 4000 }),
      ],
      new Set(["w1"]),
    );
    expect(note).toBeUndefined();
  });

  test("another editing run is not a review", () => {
    const note = gate(
      [
        run({ runId: "w1" }),
        run({ runId: "w2", agentId: "worker-b", createdAt: 3000, terminalAt: 4000 }),
      ],
      new Set(["w1", "w2"]),
    );
    expect(note).toContain("未经核验");
  });

  test("a review that finished before the change does not count", () => {
    const note = gate(
      [
        run({ runId: "w2", agentId: "worker-b", createdAt: 100, terminalAt: 200 }),
        run({ runId: "w1", createdAt: 1000, terminalAt: 2000 }),
      ],
      new Set(["w1"]),
    );
    expect(note).toContain("未经核验");
  });

  test("a run the front desk itself started is not a second opinion", () => {
    const note = gate([run({ runId: "w1", agentId: "pa", parentRunId: null })], new Set(["w1"]));
    expect(note).toBeUndefined();
  });
});

describe("what counts as producing a change", () => {
  test("edit and a push are production", () => {
    expect(producedByEvent('{"toolName":"edit"}')).toBe(true);
    expect(producedByEvent('{"toolName":"mcp__product-tools__project_push"}')).toBe(true);
  });

  test("a verifier's own report file is not production", () => {
    // measured: the Reviewer used write + artifact_upload + report, never edit
    expect(producedByEvent('{"toolName":"write"}')).toBe(false);
    expect(producedByEvent('{"toolName":"mcp__product-tools__artifact_upload"}')).toBe(false);
    expect(producedByEvent('{"toolName":"read"}')).toBe(false);
  });
});

describe("the requirement is the unit of delivery (ADR 0077)", () => {
  test("a worker a person drove on a direct line is a producer too", () => {
    // parentRunId is null when a human, not a dispatcher, started the run.
    const note = gate([run({ runId: "w-direct", parentRunId: null })], new Set(["w-direct"]));
    expect(note).toContain("未经核验");
  });

  test("a review from ANY room of the requirement clears it", () => {
    const note = gate(
      [
        run({ runId: "w1", parentRunId: null }),
        run({
          runId: "w2",
          agentId: "reviewer",
          parentRunId: "pa-2",
          createdAt: 3000,
          terminalAt: 4000,
        }),
      ],
      new Set(["w1"]),
    );
    expect(note).toBeUndefined();
  });
});
