import { describe, expect, test } from "bun:test";
import {
  FORWARD_TRANSITIONS as FE_FORWARD_TRANSITIONS,
  HUMAN_GATES as FE_HUMAN_GATES,
  ORDER as FE_ORDER,
  configurableStatuses as feConfigurableStatuses,
} from "@/lib/issue-labels";
import {
  BACKWARD_EDGES as BE_BACKWARD_EDGES,
  HUMAN_GATES as BE_HUMAN_GATES,
  LEGAL_TRANSITIONS as BE_LEGAL_TRANSITIONS,
  ORDER as BE_ORDER,
  configurableStatuses as beConfigurableStatuses,
} from "../../../backend/src/features/orchestrator/transitions.ts";

// The web bundle can't import the backend package at runtime (separate Next
// build), so issue-labels.ts hand-duplicates ORDER/HUMAN_GATES. This test is the
// guard: it imports the backend source directly and fails if the copies drift.
describe("issue-labels parity with backend orchestrator/transitions", () => {
  test("ORDER matches backend", () => {
    expect(FE_ORDER).toEqual(BE_ORDER);
  });

  test("HUMAN_GATES matches backend", () => {
    expect([...FE_HUMAN_GATES].sort()).toEqual([...BE_HUMAN_GATES].sort());
  });

  test("configurableStatuses matches backend", () => {
    expect(feConfigurableStatuses()).toEqual(beConfigurableStatuses());
  });

  // FORWARD_TRANSITIONS is forward-only: it must equal the backend's
  // LEGAL_TRANSITIONS with the backward (rework) edges removed. Rework is
  // driven by the Approve/Reject decision flow, never the "advance" button.
  test("FORWARD_TRANSITIONS matches backend LEGAL_TRANSITIONS minus backward edges", () => {
    const forwardOnly = Object.fromEntries(
      Object.entries(BE_LEGAL_TRANSITIONS).map(([from, tos]) => [
        from,
        tos.filter((to) => !BE_BACKWARD_EDGES.some((e) => e.from === from && e.to === to)),
      ]),
    );
    expect(FE_FORWARD_TRANSITIONS).toEqual(forwardOnly);
  });
});
