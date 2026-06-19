import { describe, expect, test } from "bun:test";
import {
  deriveLegalMap,
  deriveStatuses,
  ISSUE_STATUSES,
  LEGAL_TRANSITIONS,
  nextTransition,
  ORDER,
  type Transition,
} from "./transitions.js";

/** Build a fixed Transition[] from ORDER — mirrors the internal fixedTransitions(). */
function makeFixed(): Transition[] {
  const out: Transition[] = [];
  for (let i = 0; i < ORDER.length - 1; i++) {
    out.push({
      from: ORDER[i]!,
      to: ORDER[i + 1]!,
      agentId: "test-agent",
      promptTemplate: "test prompt",
    });
  }
  return out;
}

const FIXED = makeFixed();

describe("deriveStatuses", () => {
  test("returns statuses in topological order from ORDER-based transitions", () => {
    const statuses = deriveStatuses(FIXED);
    expect(statuses).toEqual(["draft", "planned", "in_progress", "in_review", "done"]);
  });
});

describe("deriveLegalMap", () => {
  test("maps each status to its legal next statuses", () => {
    const map = deriveLegalMap(FIXED);
    expect(map.draft).toEqual(["planned"]);
    expect(map.planned).toEqual(["in_progress"]);
    expect(map.in_progress).toEqual(["in_review"]);
    expect(map.in_review).toEqual(["done"]);
    expect(map.done).toEqual([]);
  });
});

describe("nextTransition", () => {
  test("finds the transition for a given from-status", () => {
    const t = nextTransition(FIXED, "planned");
    expect(t).toBeDefined();
    expect(t!.from).toBe("planned");
    expect(t!.to).toBe("in_progress");
  });

  test("returns undefined for terminal status done", () => {
    expect(nextTransition(FIXED, "done")).toBeUndefined();
  });

  test("finds draft→planned transition", () => {
    const t = nextTransition(FIXED, "draft");
    expect(t).toBeDefined();
    expect(t!.from).toBe("draft");
    expect(t!.to).toBe("planned");
  });
});

describe("derived constants", () => {
  test("ISSUE_STATUSES includes draft as the new starting state", () => {
    expect(ISSUE_STATUSES).toEqual(["draft", "planned", "in_progress", "in_review", "done"]);
  });

  test("LEGAL_TRANSITIONS includes draft→planned", () => {
    expect(LEGAL_TRANSITIONS.draft).toEqual(["planned"]);
    expect(LEGAL_TRANSITIONS.planned).toEqual(["in_progress"]);
    expect(LEGAL_TRANSITIONS.done).toEqual([]);
  });
});
