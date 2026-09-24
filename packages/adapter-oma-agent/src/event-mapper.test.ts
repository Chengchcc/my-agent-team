import { describe, expect, test } from "bun:test";
import { mapRunEvent } from "./event-mapper.js";

describe("tool event mapping (injected tools reach the web as native_tool_*)", () => {
  test("tool_execution_start with an injected tool name maps to native_tool_started", () => {
    const ev = mapRunEvent({
      id: 1,
      type: "tool_execution_start",
      data: { toolName: "todo_write", callId: "call-1" },
    } as never);
    expect(ev).toEqual({ type: "native_tool_started", toolName: "todo_write", callId: "call-1" });
  });

  test("tool_execution_end carries the result for the web tool card", () => {
    const ev = mapRunEvent({
      id: 2,
      type: "tool_execution_end",
      data: { toolName: "history_recent", callId: "call-2", result: { content: "[]" } },
    } as never);
    expect(ev).toEqual({
      type: "native_tool_completed",
      toolName: "history_recent",
      callId: "call-2",
      result: { content: "[]" },
    });
  });
});

describe("the adapter forwards the child's activity line verbatim", () => {
  test("tool_execution_start keeps activity and never forwards input", () => {
    const ev = mapRunEvent({
      id: 9,
      type: "tool_execution_start",
      data: {
        toolName: "bash",
        callId: "call-9",
        input: { command: "curl -H 'Authorization: Bearer super-secret-token'" },
        activity: "正在执行：curl -H 'Authorization: Bearer [已隐藏]'",
      },
    } as never);
    // The backend consumes THIS copy, not the oma-side one — if this
    // passthrough is dropped, Web and Lark silently lose the activity line.
    expect(ev).toEqual({
      type: "native_tool_started",
      toolName: "bash",
      callId: "call-9",
      activity: "正在执行：curl -H 'Authorization: Bearer [已隐藏]'",
    });
    expect(JSON.stringify(ev)).not.toContain("super-secret-token");
  });

  test("a child without an activity line produces none (no synthesis)", () => {
    const ev = mapRunEvent({
      id: 10,
      type: "tool_execution_start",
      data: { toolName: "read", callId: "call-10" },
    } as never);
    expect(ev).toEqual({ type: "native_tool_started", toolName: "read", callId: "call-10" });
  });
});
