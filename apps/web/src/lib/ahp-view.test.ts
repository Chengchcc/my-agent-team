import { describe, expect, test } from "bun:test";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { chatViewFromState } from "./ahp-view";

const state = (turns: unknown[], extra: Record<string, unknown> = {}): ChatState =>
  ({
    resource: "ahp-chat:/c1",
    title: "t",
    status: 1,
    modifiedAt: new Date(0).toISOString(),
    turns,
    ...extra,
  }) as ChatState;

describe("the transient view from AHP chat state", () => {
  test("text and thinking accumulate in the order they arrived", () => {
    const view = chatViewFromState(
      state([
        {
          id: "run-1",
          state: "complete",
          message: { text: "go", origin: { kind: "user" } },
          responseParts: [
            { kind: "reasoning", id: "r0", content: "thinking first" },
            { kind: "markdown", id: "t0", content: "answer" },
          ],
        },
      ]),
      "agent-1",
    );
    expect(view.transients["run-1"]).toMatchObject({
      text: "answer",
      thinking: "thinking first",
      agentId: "agent-1",
    });
    expect(view.transients["run-1"]?.ordered).toEqual([
      { type: "thinking", text: "thinking first" },
      { type: "text", text: "answer" },
    ]);
  });

  test("a tool call becomes a live step with the state it reached", () => {
    const view = chatViewFromState(
      state([
        {
          id: "run-2",
          state: "complete",
          message: { text: "go", origin: { kind: "user" } },
          responseParts: [
            {
              kind: "toolCall",
              toolCall: {
                toolCallId: "call-1",
                toolName: "bash",
                displayName: "bash",
                status: "completed",
                success: true,
                invocationMessage: "ls",
              },
            },
          ],
        },
      ]),
      "agent-1",
    );
    expect(view.tools["run-2:call-1"]).toMatchObject({
      runId: "run-2",
      callId: "call-1",
      name: "bash",
      state: "done",
    });
  });

  test("the run's todo list comes from the chat's metadata", () => {
    const view = chatViewFromState(
      state([], {
        _meta: { todos: [{ id: "t1", text: "first", status: "in_progress" }] },
        activeTurn: {
          id: "run-3",
          startedAt: new Date(0).toISOString(),
          message: { text: "go", origin: { kind: "user" } },
          responseParts: [{ kind: "markdown", id: "t0", content: "working" }],
          usage: undefined,
        },
      }),
      "agent-1",
    );
    expect(view.todos["run-3"]).toEqual([{ id: "t1", text: "first", status: "in_progress" }]);
    expect(view.transients["run-3"]?.text).toBe("working");
  });
});
