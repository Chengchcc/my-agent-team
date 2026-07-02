import { describe, expect, test } from "bun:test";
import { loopReducer } from "./loop-reducer.js";
import type { LoopState } from "./types.js";

function emptyState(): LoopState {
  return { loopId: "test", lastRun: null, items: {} };
}

function stateWith(items: LoopState["items"]): LoopState {
  return { loopId: "test", lastRun: null, items: { ...items } };
}

// ============================================================
// TICK
// ============================================================
describe("loopReducer — TICK", () => {
  test("triaged → fixing (all)", () => {
    const s = stateWith({
      "01": {
        id: "01",
        source: "ci",
        summary: "a",
        step: "triaged",
        attempt: 1,
        priority: 0,
        result: null,
      },
      "02": {
        id: "02",
        source: "ci",
        summary: "b",
        step: "triaged",
        attempt: 1,
        priority: 0,
        result: null,
      },
    });
    const next = loopReducer(s, { type: "TICK" });
    expect(next.items["01"]!.step).toBe("fixing");
    expect(next.items["02"]!.step).toBe("fixing");
  });

  test("non-triaged items unchanged", () => {
    const s = stateWith({
      "01": {
        id: "01",
        source: "ci",
        summary: "a",
        step: "fixing",
        attempt: 1,
        priority: 0,
        result: null,
      },
      "02": {
        id: "02",
        source: "ci",
        summary: "b",
        step: "awaiting_review",
        attempt: 1,
        priority: 0,
        result: null,
      },
    });
    const next = loopReducer(s, { type: "TICK" });
    expect(next.items["01"]!.step).toBe("fixing");
    expect(next.items["02"]!.step).toBe("awaiting_review");
  });

  test("empty state unchanged", () => {
    const s = emptyState();
    const next = loopReducer(s, { type: "TICK" });
    expect(next.items).toEqual({});
  });

  test("immutability: original state not modified", () => {
    const s = stateWith({
      "01": {
        id: "01",
        source: "ci",
        summary: "a",
        step: "triaged",
        attempt: 1,
        priority: 0,
        result: null,
      },
    });
    loopReducer(s, { type: "TICK" });
    expect(s.items["01"]!.step).toBe("triaged");
  });
});

// ============================================================
// GENERATOR_DONE
// ============================================================
describe("loopReducer — GENERATOR_DONE", () => {
  test("fixing → verifying, result cleared", () => {
    const s = stateWith({
      "01": {
        id: "01",
        source: "ci",
        summary: "a",
        step: "fixing",
        attempt: 1,
        priority: 0,
        result: { verdict: "REJECT", reasons: ["old"], evidence: "x" },
      },
    });
    const next = loopReducer(s, { type: "GENERATOR_DONE", itemId: "01" });
    expect(next.items["01"]!.step).toBe("verifying");
    expect(next.items["01"]!.result).toBeNull();
  });

  test("non-fixing item unchanged", () => {
    const s = stateWith({
      "01": {
        id: "01",
        source: "ci",
        summary: "a",
        step: "triaged",
        attempt: 1,
        priority: 0,
        result: null,
      },
    });
    const next = loopReducer(s, { type: "GENERATOR_DONE", itemId: "01" });
    expect(next.items["01"]!.step).toBe("triaged");
  });

  test("unknown itemId → no-op", () => {
    const s = emptyState();
    const next = loopReducer(s, { type: "GENERATOR_DONE", itemId: "nope" });
    expect(next).toEqual(s);
  });
});

// ============================================================
// EVALUATOR_VERDICT
// ============================================================
describe("loopReducer — EVALUATOR_VERDICT", () => {
  const verifyingItem = {
    id: "01",
    source: "ci",
    summary: "a",
    step: "verifying" as const,
    attempt: 1,
    priority: 0,
    result: null,
  };

  test("PASS → awaiting_review (L2 default)", () => {
    const s = stateWith({ "01": verifyingItem });
    const next = loopReducer(s, {
      type: "EVALUATOR_VERDICT",
      itemId: "01",
      verdict: { verdict: "PASS", evidence: "12/12 green" },
    });
    expect(next.items["01"]!.step).toBe("awaiting_review");
  });

  test("PASS → resolved (L3 autoResolve)", () => {
    const s = stateWith({ "01": verifyingItem });
    const next = loopReducer(
      s,
      {
        type: "EVALUATOR_VERDICT",
        itemId: "01",
        verdict: { verdict: "PASS", evidence: "12/12 green" },
      },
      { autoResolve: true },
    );
    expect(next.items["01"]!.step).toBe("resolved");
  });

  test("PASS with empty evidence → no-op", () => {
    const s = stateWith({ "01": verifyingItem });
    const next = loopReducer(s, {
      type: "EVALUATOR_VERDICT",
      itemId: "01",
      verdict: { verdict: "PASS", evidence: "" },
    });
    expect(next.items["01"]!.step).toBe("verifying");
  });

  test("PASS with whitespace-only evidence → no-op", () => {
    const s = stateWith({ "01": verifyingItem });
    const next = loopReducer(s, {
      type: "EVALUATOR_VERDICT",
      itemId: "01",
      verdict: { verdict: "PASS", evidence: "   " },
    });
    expect(next.items["01"]!.step).toBe("verifying");
  });

  test("REJECT → fixing (attempt < maxRetries)", () => {
    const s = stateWith({ "01": verifyingItem });
    const next = loopReducer(s, {
      type: "EVALUATOR_VERDICT",
      itemId: "01",
      verdict: { verdict: "REJECT", reasons: ["scope drift"], evidence: "x" },
    });
    expect(next.items["01"]!.step).toBe("fixing");
    expect(next.items["01"]!.attempt).toBe(2);
  });

  test("REJECT → inbox (attempt >= maxRetries)", () => {
    const s = stateWith({
      "01": { ...verifyingItem, attempt: 3 },
    });
    const next = loopReducer(s, {
      type: "EVALUATOR_VERDICT",
      itemId: "01",
      verdict: { verdict: "REJECT", reasons: ["scope drift"], evidence: "x" },
    });
    expect(next.items["01"]!.step).toBe("inbox");
  });

  test("REJECT with custom maxRetries", () => {
    const s = stateWith({ "01": { ...verifyingItem, attempt: 2 } });
    const next = loopReducer(
      s,
      {
        type: "EVALUATOR_VERDICT",
        itemId: "01",
        verdict: { verdict: "REJECT", reasons: ["x"], evidence: "x" },
      },
      { maxRetries: 2 },
    );
    expect(next.items["01"]!.step).toBe("inbox");
  });

  test("ESCALATE → inbox", () => {
    const s = stateWith({ "01": verifyingItem });
    const next = loopReducer(s, {
      type: "EVALUATOR_VERDICT",
      itemId: "01",
      verdict: { verdict: "ESCALATE", reasons: ["no env"], evidence: "mcp unreachable" },
    });
    expect(next.items["01"]!.step).toBe("inbox");
  });

  test("non-verifying item unchanged", () => {
    const s = stateWith({ "01": { ...verifyingItem, step: "fixing" as const } });
    const next = loopReducer(s, {
      type: "EVALUATOR_VERDICT",
      itemId: "01",
      verdict: { verdict: "PASS", evidence: "x" },
    });
    expect(next.items["01"]!.step).toBe("fixing");
  });

  test("unknown itemId → no-op", () => {
    const s = emptyState();
    const next = loopReducer(s, {
      type: "EVALUATOR_VERDICT",
      itemId: "nope",
      verdict: { verdict: "PASS", evidence: "x" },
    });
    expect(next).toEqual(s);
  });
});

// ============================================================
// APPROVE / REJECT_HUMAN / PROMOTE
// ============================================================
describe("loopReducer — APPROVE / REJECT_HUMAN / PROMOTE", () => {
  const awItem = {
    id: "01",
    source: "ci",
    summary: "a",
    step: "awaiting_review" as const,
    attempt: 1,
    priority: 0,
    result: null,
  };

  test("APPROVE → resolved", () => {
    const s = stateWith({ "01": awItem });
    const next = loopReducer(s, { type: "APPROVE", itemId: "01" });
    expect(next.items["01"]!.step).toBe("resolved");
  });

  test("APPROVE non-awaiting_review → no-op", () => {
    const s = stateWith({ "01": { ...awItem, step: "fixing" as const } });
    const next = loopReducer(s, { type: "APPROVE", itemId: "01" });
    expect(next.items["01"]!.step).toBe("fixing");
  });

  test("REJECT_HUMAN → inbox with feedback", () => {
    const s = stateWith({ "01": awItem });
    const next = loopReducer(s, { type: "REJECT_HUMAN", itemId: "01", feedback: "wrong approach" });
    expect(next.items["01"]!.step).toBe("inbox");
    expect(next.items["01"]!.result).toEqual({
      verdict: "REJECT",
      reasons: ["wrong approach"],
      evidence: "",
    });
  });

  test("REJECT_HUMAN without feedback → default message", () => {
    const s = stateWith({ "01": awItem });
    const next = loopReducer(s, { type: "REJECT_HUMAN", itemId: "01" });
    expect(next.items["01"]!.result).toEqual({
      verdict: "REJECT",
      reasons: ["手动驳回"],
      evidence: "",
    });
  });

  test("PROMOTE → promoted", () => {
    const s = stateWith({ "01": awItem });
    const next = loopReducer(s, { type: "PROMOTE", itemId: "01" });
    expect(next.items["01"]!.step).toBe("promoted");
  });

  test("PROMOTE non-awaiting_review → no-op", () => {
    const s = stateWith({ "01": { ...awItem, step: "triaged" as const } });
    const next = loopReducer(s, { type: "PROMOTE", itemId: "01" });
    expect(next.items["01"]!.step).toBe("triaged");
  });
});

// ============================================================
// RETRY / DISMISS
// ============================================================
describe("loopReducer — RETRY / DISMISS", () => {
  const inboxItem = {
    id: "01",
    source: "ci",
    summary: "a",
    step: "inbox" as const,
    attempt: 3,
    priority: 0,
    result: { verdict: "REJECT" as const, reasons: ["scope drift"], evidence: "x" },
  };

  test("RETRY → triaged, attempt reset, result cleared", () => {
    const s = stateWith({ "01": inboxItem });
    const next = loopReducer(s, { type: "RETRY", itemId: "01" });
    expect(next.items["01"]!.step).toBe("triaged");
    expect(next.items["01"]!.attempt).toBe(1);
    expect(next.items["01"]!.result).toBeNull();
  });

  test("RETRY non-inbox → no-op", () => {
    const s = stateWith({ "01": { ...inboxItem, step: "fixing" as const } });
    const next = loopReducer(s, { type: "RETRY", itemId: "01" });
    expect(next.items["01"]!.step).toBe("fixing");
  });

  test("DISMISS → item removed", () => {
    const s = stateWith({ "01": inboxItem, "02": { ...inboxItem, id: "02" } });
    const next = loopReducer(s, { type: "DISMISS", itemId: "01" });
    expect(next.items["01"]).toBeUndefined();
    expect(next.items["02"]).toBeDefined();
  });

  test("DISMISS non-inbox → no-op", () => {
    const s = stateWith({ "01": { ...inboxItem, step: "fixing" as const } });
    const next = loopReducer(s, { type: "DISMISS", itemId: "01" });
    expect(next.items["01"]).toBeDefined();
  });

  test("DISMISS unknown itemId → no-op", () => {
    const s = emptyState();
    const next = loopReducer(s, { type: "DISMISS", itemId: "nope" });
    expect(next).toEqual(s);
  });
});

// ============================================================
// ADD_ITEM
// ============================================================
describe("loopReducer — ADD_ITEM", () => {
  test("new item added as triaged", () => {
    const s = emptyState();
    const next = loopReducer(s, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "auth flaky" },
    });
    expect(next.items["01"]!.step).toBe("triaged");
    expect(next.items["01"]!.attempt).toBe(1);
    expect(next.items["01"]!.priority).toBe(0);
    expect(next.items["01"]!.result).toBeNull();
    expect(next.items["01"]!.source).toBe("ci");
    expect(next.items["01"]!.summary).toBe("auth flaky");
  });

  test("ADD_ITEM with explicit priority", () => {
    const s = emptyState();
    const next = loopReducer(s, {
      type: "ADD_ITEM",
      item: { id: "01", source: "ci", summary: "critical" },
      priority: 1,
    });
    expect(next.items["01"]!.priority).toBe(1);
  });

  test("ADD_ITEM id conflict → no-op, original preserved", () => {
    const existing = {
      id: "01",
      source: "ci",
      summary: "original",
      step: "fixing" as const,
      attempt: 2,
      priority: 5,
      result: null,
    };
    const s = stateWith({ "01": existing });
    const next = loopReducer(s, {
      type: "ADD_ITEM",
      item: { id: "01", source: "issue", summary: "duplicate" },
    });
    expect(next.items["01"]!.step).toBe("fixing");
    expect(next.items["01"]!.summary).toBe("original");
    expect(next.items["01"]!.priority).toBe(5);
  });
});

// ============================================================
// Immutability
// ============================================================
describe("loopReducer — immutability", () => {
  test("returned state is new object (shallow)", () => {
    const s = emptyState();
    const next = loopReducer(s, { type: "TICK" });
    expect(next).not.toBe(s);
    expect(next.items).not.toBe(s.items);
  });

  test("items record is new object even if no items changed", () => {
    const s = stateWith({
      "01": {
        id: "01",
        source: "ci",
        summary: "a",
        step: "fixing",
        attempt: 1,
        priority: 0,
        result: null,
      },
    });
    const next = loopReducer(s, { type: "TICK" });
    expect(next.items).not.toBe(s.items);
  });
});
