import { describe, expect, test } from "bun:test";
import type { Message } from "./message.js";
import { attachInputRequests, turnPartsFromMessages } from "./session-model.js";

const use = (id: string, name: string, input: unknown = {}): Message => ({
  role: "assistant",
  blocks: [{ type: "tool_use", id, name, input }],
});
const result = (id: string, content: string, isError = false): Message => ({
  role: "tool",
  blocks: [
    { type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) },
  ],
});
const text = (t: string): Message => ({ role: "assistant", text: t });

describe("canonical turn parts", () => {
  test("text becomes a text part", () => {
    expect(turnPartsFromMessages([text("hello")])).toEqual([{ kind: "text", text: "hello" }]);
  });

  test("a tool call is one part carrying its own result", () => {
    const parts = turnPartsFromMessages([
      use("a", "bash", { command: "ls" }),
      result("a", "file.txt"),
      text("done"),
    ]);
    expect(parts).toEqual([
      {
        kind: "toolCall",
        toolCall: {
          toolCallId: "a",
          name: "bash",
          input: { command: "ls" },
          status: "completed",
          result: { content: "file.txt", isError: false },
        },
      },
      { kind: "text", text: "done" },
    ]);
  });

  test("N calls leave N toolCall parts (the acceptance vector)", () => {
    const parts = turnPartsFromMessages([
      use("a", "bash"),
      result("a", "ok"),
      use("b", "write"),
      result("b", "permission denied", true),
      use("c", "grep"),
    ]);
    const calls = parts.flatMap((p) => (p.kind === "toolCall" ? [p.toolCall] : []));
    expect(calls.map((c) => c.toolCallId)).toEqual(["a", "b", "c"]);
    expect(calls.map((c) => c.status)).toEqual(["completed", "failed", "pending"]);
    expect(calls[1]?.result).toEqual({ content: "permission denied", isError: true });
    expect(calls[2]?.result).toBeUndefined();
  });

  test("a result with no matching use stays a settled call, never dropped", () => {
    const parts = turnPartsFromMessages([result("orphan", "output")]);
    expect(parts).toEqual([
      {
        kind: "toolCall",
        toolCall: {
          toolCallId: "orphan",
          name: "unknown",
          input: {},
          status: "completed",
          result: { content: "output", isError: false },
        },
      },
    ]);
  });

  test("message errors become error parts", () => {
    const parts = turnPartsFromMessages([
      { role: "assistant", error: { message: "model timed out", code: "timeout" } },
    ]);
    expect(parts).toEqual([{ kind: "error", message: "model timed out", code: "timeout" }]);
  });

  test("input requests land after the call they belong to, others trail", () => {
    const parts = turnPartsFromMessages([use("a", "bash"), result("a", "ok"), text("done")]);
    const withRequests = attachInputRequests(parts, [
      { requestId: "r2", kind: "question", status: "pending" },
      {
        requestId: "r1",
        kind: "approval",
        status: "resolved",
        toolCallId: "a",
        response: { decision: "deny" },
      },
    ]);
    expect(withRequests.map((p) => p.kind)).toEqual([
      "toolCall",
      "inputRequest",
      "text",
      "inputRequest",
    ]);
    expect(withRequests[1]).toMatchObject({
      request: { requestId: "r1", toolCallId: "a", status: "resolved" },
    });
    expect(withRequests[3]).toMatchObject({ request: { requestId: "r2" } });
  });
});
