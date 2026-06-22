import { describe, expect, test } from "bun:test";
import {
  HUMAN_GATES as FE_HUMAN_GATES,
  ORDER as FE_ORDER,
  configurableStatuses as feConfigurableStatuses,
} from "@/lib/issue-labels";
import {
  HUMAN_GATES as BE_HUMAN_GATES,
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
});
