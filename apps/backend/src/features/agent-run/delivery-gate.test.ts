import { describe, expect, test } from "bun:test";
import { type DeliveryGateRun, deliveryNoteOf } from "./delivery-gate.js";

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
