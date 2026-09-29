import { describe, expect, test } from "bun:test";
import type { schema } from "@agentclientprotocol/sdk";
import type { BackendEvent } from "@chengchenccc/agent-contract";
import { createAcpAccumulator, mapAcpUpdate, mapAcpUsage } from "./event-mapping.js";

type Update = schema.SessionNotification["update"];

function message(text: string): Update {
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
}

describe("mapAcpUpdate", () => {
  test("message chunks become text deltas and accumulate outcome text", () => {
    const acc = createAcpAccumulator();
    expect(mapAcpUpdate(acc, message("hello "))).toEqual([{ type: "text_delta", text: "hello " }]);
    mapAcpUpdate(acc, message("world"));
    expect(acc.texts).toEqual(["hello ", "world"]);
  });

  test("thought chunks become thinking deltas without touching outcome text", () => {
    const acc = createAcpAccumulator();
    const events = mapAcpUpdate(acc, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "pondering" },
    });
    expect(events).toEqual([{ type: "thinking_delta", text: "pondering" }]);
    expect(acc.texts).toEqual([]);
  });

  test("tool_call lifecycle: pending starts (title rides as activity), completed ends (rawOutput as result)", () => {
    const acc = createAcpAccumulator();
    const started = mapAcpUpdate(acc, {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "Running tests",
      name: "bash",
      kind: "execute",
      status: "pending",
    } as Update);
    expect(started).toEqual([
      {
        type: "native_tool_started",
        toolName: "bash",
        callId: "call-1",
        activity: "Running tests",
      },
    ]);
    const completed = mapAcpUpdate(acc, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      rawOutput: { ok: true },
    } as Update);
    expect(completed).toEqual([
      { type: "native_tool_completed", toolName: "bash", callId: "call-1", result: { ok: true } },
    ]);
  });

  test("tool name falls back to title, then unknown — never synthesized", () => {
    const acc = createAcpAccumulator();
    const byTitle = mapAcpUpdate(acc, {
      sessionUpdate: "tool_call",
      toolCallId: "c",
      title: "Read file",
      status: "pending",
    } as Update);
    expect(byTitle[0]).toMatchObject({ toolName: "Read file" });
    const bare = mapAcpUpdate(acc, {
      sessionUpdate: "tool_call_update",
      toolCallId: "c2",
      status: "in_progress",
    } as Update);
    expect(bare[0]).toMatchObject({ toolName: "unknown" });
  });

  test("plan updates ride the oma-namespaced todo event with mapped statuses", () => {
    const acc = createAcpAccumulator();
    const events: readonly BackendEvent<"acp">[] = mapAcpUpdate(acc, {
      sessionUpdate: "plan",
      entries: [
        { content: "first", priority: "high", status: "completed" },
        { content: "second", priority: "low", status: "in_progress" },
        { content: "third", priority: "medium", status: "pending" },
      ],
    } as Update);
    expect(events).toEqual([
      {
        type: "backend.oma.todo_update",
        payload: {
          items: [
            { id: "0", text: "first", status: "done" },
            { id: "1", text: "second", status: "in_progress" },
            { id: "2", text: "third", status: "pending" },
          ],
        },
      },
    ]);
    expect(mapAcpUpdate(acc, { sessionUpdate: "plan_removed" } as Update)).toEqual([
      { type: "backend.oma.todo_update", payload: { items: [] } },
    ]);
  });

  test("non-product kinds drop silently", () => {
    const acc = createAcpAccumulator();
    expect(
      mapAcpUpdate(acc, {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "echo" },
      } as Update),
    ).toEqual([]);
    expect(
      mapAcpUpdate(acc, { sessionUpdate: "session_info_update", title: "t" } as Update),
    ).toEqual([]);
  });
});

describe("mapAcpUsage", () => {
  test("maps present fields, keeps absent ones absent", () => {
    expect(mapAcpUsage({ inputTokens: 10, outputTokens: 5 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(mapAcpUsage({ inputTokens: 1 })).toEqual({ inputTokens: 1 });
    expect(mapAcpUsage(null)).toBeUndefined();
    expect(mapAcpUsage(undefined)).toBeUndefined();
    expect(mapAcpUsage({})).toBeUndefined();
  });
});
