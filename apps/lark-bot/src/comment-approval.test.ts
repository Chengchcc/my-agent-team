import { describe, expect, test } from "bun:test";
import { APPROVAL_HINT, formatPendingQuestion, parseApprovalAnswer } from "./comment-approval.js";

describe("a parked run, in a thread that has no card", () => {
  test("an approval shows the action and how to answer it", () => {
    const text = formatPendingQuestion({
      kind: "approval",
      detail: 'ps aux | grep -iE "lark"',
      toolName: "execute",
    });
    expect(text).toContain('ps aux | grep -iE "lark"');
    expect(text).toContain("execute");
    expect(text).toContain(APPROVAL_HINT);
  });

  test("an ask is just the question", () => {
    const text = formatPendingQuestion({ kind: "ask", detail: "用哪个分支？" });
    expect(text).toContain("用哪个分支？");
    expect(text).not.toContain(APPROVAL_HINT);
  });

  test("an empty action says so rather than showing nothing", () => {
    expect(formatPendingQuestion({ kind: "approval", detail: "  " })).toContain("动作内容为空");
  });
});

describe("what the next comment means while a run is parked", () => {
  test("allow and deny, in the words a person actually types", () => {
    for (const yes of ["允许", "同意", "批准", "可以", "Allow", "APPROVE", "yes", "OK"])
      expect(parseApprovalAnswer(yes)).toBe("allow");
    for (const no of ["拒绝", "不行", "不要", "Deny", "reject", "no"])
      expect(parseApprovalAnswer(no)).toBe("deny");
  });

  test("anything else is a NEW request, not an answer", () => {
    // Guessing here would swallow the new request silently, which is worse
    // than starting a run the user did not want.
    expect(parseApprovalAnswer("允许，另外帮我改一下开头")).toBeNull();
    expect(parseApprovalAnswer("顺便总结一下")).toBeNull();
    expect(parseApprovalAnswer("  ")).toBeNull();
  });
});
