import { describe, expect, test } from "bun:test";
import {
  clearTransientApproval,
  formatDeadline,
  markTransientApprovalError,
  type RunTodoMap,
  setRunTodos,
  type TransientApproval,
  type TransientMap,
  toolKey,
} from "./transient-reducer";

/** An approval card as the chat channel builds it (chat-state's `cardOf` hands over the same
 *  shape); these tests are about what the card does afterwards. */
function withApproval(s: TransientMap, runId: string, approval: TransientApproval): TransientMap {
  return {
    ...s,
    [runId]: { text: "", thinking: "", ordered: [], agentId: runId, approval },
  };
}

describe("transient reducer — todos", () => {
  test("todo update replaces the full snapshot", () => {
    let s: RunTodoMap = {};
    s = setRunTodos(s, "r1", [{ id: "a", text: "step 1", status: "done" }]);
    s = setRunTodos(s, "r1", [
      { id: "a", text: "step 1", status: "done" },
      { id: "b", text: "step 2", status: "pending" },
    ]);
    expect(s.r1).toHaveLength(2);
  });
});

describe("transient reducer — approval", () => {
  test("detail survives the approval round-trip and a failed resolve", () => {
    let s: TransientMap = {};
    s = withApproval(s, "r1", {
      callId: "c1",
      toolName: "bash",
      reason: "permission",
      detail: "echo lark-resume-acceptance",
    });
    expect(s.r1?.approval?.detail).toBe("echo lark-resume-acceptance");
    s = markTransientApprovalError(s, "r1", "boom");
    expect(s.r1?.approval?.detail).toBe("echo lark-resume-acceptance");
  });

  test("a deadline survives the round-trip and formats in local time", () => {
    const deadlineAt = Date.now() + 24 * 60 * 60_000;
    let s: TransientMap = {};
    s = withApproval(s, "r2", {
      callId: "c2",
      toolName: "bash",
      reason: "",
      detail: "true",
      deadlineAt,
    });
    expect(s.r2?.approval?.deadlineAt).toBe(deadlineAt);
    expect(formatDeadline(deadlineAt)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  test("clearTransientApproval removes only that run's approval", () => {
    let s: TransientMap = {};
    s = withApproval(s, "r1", { callId: "c1", toolName: "bash", reason: "r1" });
    s = withApproval(s, "r2", { callId: "c9", toolName: "read", reason: "r2" });
    s = clearTransientApproval(s, "r1");
    expect(s.r1?.approval).toBeUndefined();
    expect(s.r2?.approval?.callId).toBe("c9");
  });

  test("markTransientApprovalError keeps the card and carries the error", () => {
    let s: TransientMap = {};
    s = withApproval(s, "r1", { callId: "c1", toolName: "bash", reason: "r1" });
    s = markTransientApprovalError(s, "r1", "resolve failed — retry");
    // The card STAYS: the decision never reached the backend.
    expect(s.r1?.approval?.callId).toBe("c1");
    expect(s.r1?.approval?.error).toBe("resolve failed — retry");
    // No pending approval on that run (or no run): no-op.
    expect(markTransientApprovalError(s, "r2", "x")).toBe(s);
    s = clearTransientApproval(s, "r1");
    expect(markTransientApprovalError(s, "r1", "x")).toBe(s);
  });

  test("sandboxed survives the approval round-trip", () => {
    let s: TransientMap = {};
    s = withApproval(s, "r1", {
      callId: "c1",
      toolName: "bash",
      reason: "r1",
      sandboxed: true,
    });
    expect(s.r1?.approval?.sandboxed).toBe(true);
    // A failed resolve preserves the signal alongside the error.
    s = markTransientApprovalError(s, "r1", "boom");
    expect(s.r1?.approval?.sandboxed).toBe(true);
  });
});

describe("transient reducer — tool keys", () => {
  test("toolKey distinguishes runId and callId collisions", () => {
    expect(toolKey("r1", "c1")).toBe("r1:c1");
    expect(toolKey("r1", "c1")).not.toBe(toolKey("r1", "c2"));
    expect(toolKey("r1", "c1")).not.toBe(toolKey("r2", "c1"));
  });
});
