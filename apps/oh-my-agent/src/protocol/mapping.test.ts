import { describe, expect, test } from "bun:test";
import { forWire, mapRunEvent } from "./mapping.js";

describe("delegation event mapping", () => {
  test("delegation lifecycle events map 1:1 to core events", () => {
    expect(
      mapRunEvent({
        id: 1,
        type: "delegation_batch_started",
        data: { batchId: "wf1", label: "audit", agentCount: 12 },
      }),
    ).toEqual({ type: "delegation_batch_started", batchId: "wf1", label: "audit", agentCount: 12 });
    expect(
      mapRunEvent({
        id: 2,
        type: "delegation_agent_started",
        data: { batchId: "wf1", agentId: "a1", label: "src/a.ts" },
      }),
    ).toEqual({
      type: "delegation_agent_started",
      batchId: "wf1",
      agentId: "a1",
      label: "src/a.ts",
    });
    expect(
      mapRunEvent({
        id: 3,
        type: "delegation_agent_completed",
        data: { batchId: "wf1", agentId: "a1", label: "src/a.ts", ok: true },
      }),
    ).toEqual({
      type: "delegation_agent_completed",
      batchId: "wf1",
      agentId: "a1",
      label: "src/a.ts",
      ok: true,
    });
    expect(
      mapRunEvent({
        id: 4,
        type: "delegation_batch_completed",
        data: { batchId: "wf1", ok: false, agentCount: 12, totalTokens: 500 },
      }),
    ).toEqual({
      type: "delegation_batch_completed",
      batchId: "wf1",
      ok: false,
      agentCount: 12,
      totalTokens: 500,
    });
  });

  test("an errored agent carries error + usage through", () => {
    const ev = mapRunEvent({
      id: 5,
      type: "delegation_agent_completed",
      data: {
        batchId: "wf2",
        agentId: "a2",
        label: "x",
        ok: false,
        error: "boom",
        usage: { totalTokens: 10 },
      },
    });
    expect(ev).toEqual({
      type: "delegation_agent_completed",
      batchId: "wf2",
      agentId: "a2",
      label: "x",
      ok: false,
      error: "boom",
      usage: { totalTokens: 10 },
    });
  });
});

describe("tool activity crosses the RPC boundary, raw input does not", () => {
  test("tool_execution_start maps activity through and drops input", () => {
    const mapped = mapRunEvent({
      id: 7,
      type: "tool_execution_start",
      data: {
        toolName: "bash",
        callId: "call-1",
        input: { command: "curl -H 'Authorization: Bearer secret-token-123456'" },
        activity: "正在执行：curl -H 'Authorization: [已隐藏]'",
      },
    });
    expect(mapped).toEqual({
      type: "native_tool_started",
      toolName: "bash",
      callId: "call-1",
      activity: "正在执行：curl -H 'Authorization: [已隐藏]'",
    });
    expect(JSON.stringify(mapped)).not.toContain("secret-token");
  });

  test("a tool without describeStart maps no activity (surface falls back)", () => {
    expect(
      mapRunEvent({
        id: 8,
        type: "tool_execution_start",
        data: { toolName: "mcp__github__create_issue", callId: "call-2" },
      }),
    ).toEqual({
      type: "native_tool_started",
      toolName: "mcp__github__create_issue",
      callId: "call-2",
    });
  });
});

describe("forWire keeps oma-internal fields inside the process", () => {
  test("tool_execution_start loses its raw input but keeps the activity line", () => {
    const envelope = {
      id: 3,
      type: "tool_execution_start",
      data: {
        type: "tool_execution_start",
        toolName: "bash",
        callId: "call-1",
        input: { command: "curl -H 'Authorization: Bearer super-secret-token'" },
        activity: "正在执行：curl -H 'Authorization: Bearer [已隐藏]'",
      },
    };
    const wire = forWire(envelope);
    expect(wire.data).not.toHaveProperty("input");
    expect(wire.data.activity).toBe("正在执行：curl -H 'Authorization: Bearer [已隐藏]'");
    expect(JSON.stringify(wire)).not.toContain("super-secret-token");
    // The in-process envelope is untouched: the TUI reads `input` for its card.
    expect(envelope.data.input).toBeDefined();
  });

  test("every other event type passes through unchanged", () => {
    const envelope = { id: 4, type: "tool_execution_end", data: { type: "tool_execution_end" } };
    expect(forWire(envelope)).toBe(envelope);
  });
});
