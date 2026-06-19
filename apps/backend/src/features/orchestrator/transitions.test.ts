import { describe, expect, test } from "bun:test";
import {
  BACKWARD_EDGES,
  deriveLegalMap,
  deriveStatuses,
  HUMAN_GATES,
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

describe("BACKWARD_EDGES", () => {
  test("contains the single in_review→in_progress rework edge", () => {
    expect(BACKWARD_EDGES).toEqual([{ from: "in_review", to: "in_progress" }]);
  });
});

describe("HUMAN_GATES", () => {
  test("in_review is a human gate", () => {
    expect(HUMAN_GATES.has("in_review")).toBe(true);
  });

  test("other statuses are not human gates", () => {
    expect(HUMAN_GATES.has("planned")).toBe(false);
    expect(HUMAN_GATES.has("in_progress")).toBe(false);
    expect(HUMAN_GATES.has("draft")).toBe(false);
    expect(HUMAN_GATES.has("done")).toBe(false);
  });
});

describe("LEGAL_TRANSITIONS with backward edges", () => {
  test("in_review has two legal transitions: done + in_progress (rework)", () => {
    expect(LEGAL_TRANSITIONS.in_review).toContain("done");
    expect(LEGAL_TRANSITIONS.in_review).toContain("in_progress");
    expect(LEGAL_TRANSITIONS.in_review).toHaveLength(2);
  });

  test("forward-only statuses still have exactly one legal target", () => {
    expect(LEGAL_TRANSITIONS.draft).toEqual(["planned"]);
    expect(LEGAL_TRANSITIONS.planned).toEqual(["in_progress"]);
    expect(LEGAL_TRANSITIONS.in_progress).toEqual(["in_review"]);
    expect(LEGAL_TRANSITIONS.done).toEqual([]);
  });
});

describe("nextTransition with human gate", () => {
  test("returns undefined for in_review (gate — must not auto-advance)", () => {
    expect(nextTransition(FIXED, "in_review")).toBeUndefined();
  });

  test("returns transition for non-gate statuses (forward auto-advance)", () => {
    const planned = nextTransition(FIXED, "planned");
    expect(planned).toBeDefined();
    expect(planned!.to).toBe("in_progress");

    const ip = nextTransition(FIXED, "in_progress");
    expect(ip).toBeDefined();
    expect(ip!.to).toBe("in_review");
  });

  test("returns undefined for done (terminal)", () => {
    expect(nextTransition(FIXED, "done")).toBeUndefined();
  });
});
