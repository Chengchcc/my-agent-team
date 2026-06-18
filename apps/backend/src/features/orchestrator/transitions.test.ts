import { describe, test, expect } from "bun:test";
import {
  TRANSITIONS,
  deriveStatuses,
  deriveLegalMap,
  nextTransition,
  ISSUE_STATUSES,
  LEGAL_TRANSITIONS,
} from "./transitions.js";

describe("deriveStatuses", () => {
  test("returns statuses in topological order from TRANSITIONS", () => {
    const statuses = deriveStatuses(TRANSITIONS);
    expect(statuses).toEqual(["planned", "in_progress", "in_review", "done"]);
  });
});

describe("deriveLegalMap", () => {
  test("maps each status to its legal next statuses", () => {
    const map = deriveLegalMap(TRANSITIONS);
    expect(map.planned).toEqual(["in_progress"]);
    expect(map.in_progress).toEqual(["in_review"]);
    expect(map.in_review).toEqual(["done"]);
    expect(map.done).toEqual([]);
  });
});

describe("nextTransition", () => {
  test("finds the transition for a given from-status", () => {
    const t = nextTransition(TRANSITIONS, "planned");
    expect(t).toBeDefined();
    expect(t!.from).toBe("planned");
    expect(t!.to).toBe("in_progress");
    expect(t!.agentId).toBe("planner");
  });

  test("returns undefined for terminal status done", () => {
    expect(nextTransition(TRANSITIONS, "done")).toBeUndefined();
  });
});

describe("derived constants", () => {
  test("ISSUE_STATUSES matches M18.1 values", () => {
    expect(ISSUE_STATUSES).toEqual(["planned", "in_progress", "in_review", "done"]);
  });

  test("LEGAL_TRANSITIONS matches M18.1 values", () => {
    expect(LEGAL_TRANSITIONS.planned).toEqual(["in_progress"]);
    expect(LEGAL_TRANSITIONS.done).toEqual([]);
  });
});
