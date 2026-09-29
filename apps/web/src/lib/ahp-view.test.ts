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
  const active = (parts: unknown[], id = "run-1") => ({
    id,
    startedAt: new Date(0).toISOString(),
    message: { text: "go", origin: { kind: "user" } },
    responseParts: parts,
    usage: undefined,
  });

  test("text and thinking accumulate in the order they arrived", () => {
    const view = chatViewFromState(
      state([], {
        activeTurn: active([
          { kind: "reasoning", id: "r0", content: "thinking first" },
          { kind: "markdown", id: "t0", content: "answer" },
        ]),
      }),
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

  test("a finished turn contributes nothing: its text is the canonical message", () => {
    const view = chatViewFromState(
      state([
        {
          id: "run-9",
          state: "complete",
          message: { text: "go", origin: { kind: "user" } },
          responseParts: [{ kind: "markdown", id: "t0", content: "already in the list" }],
        },
      ]),
      "agent-1",
    );
    expect(view.transients).toEqual({});
    expect(view.tools).toEqual({});
  });

  test("a tool call becomes a live step with the state it reached", () => {
    const view = chatViewFromState(
      state([], {
        activeTurn: active([
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
        ]),
      }),
      "agent-1",
    );
    expect(view.tools["run-1:call-1"]).toMatchObject({
      runId: "run-1",
      callId: "call-1",
      name: "bash",
      state: "done",
    });
  });

  test("the run's todo list comes from the chat's metadata", () => {
    const view = chatViewFromState(
      state([], {
        _meta: { todos: [{ id: "t1", text: "first", status: "in_progress" }] },
        activeTurn: active([{ kind: "markdown", id: "t0", content: "working" }], "run-3"),
      }),
      "agent-1",
    );
    expect(view.todos["run-3"]).toEqual([{ id: "t1", text: "first", status: "in_progress" }]);
    expect(view.transients["run-3"]?.text).toBe("working");
  });
});

describe("human input cards", () => {
  test("an approval card renders what was asked from the durable payload", () => {
    const view = chatViewFromState(
      state([], {
        activeTurn: {
          id: "run-4",
          startedAt: new Date(0).toISOString(),
          message: { text: "go", origin: { kind: "user" } },
          responseParts: [
            {
              kind: "inputRequest",
              request: {
                id: "run-4:call-9",
                message: "approval",
                _meta: {
                  productRequest: {
                    callId: "call-9",
                    toolName: "bash",
                    reason: "rm -rf build",
                    detail: "rm -rf build",
                    deadlineAt: 1234,
                  },
                },
              },
            },
          ],
          usage: undefined,
        },
      }),
      "agent-1",
    );
    expect(view.transients["run-4"]?.approval).toEqual({
      callId: "call-9",
      toolName: "bash",
      reason: "rm -rf build",
      detail: "rm -rf build",
      deadlineAt: 1234,
    });
  });

  test("a question lands on the ask card instead", () => {
    const view = chatViewFromState(
      state([], {
        activeTurn: {
          id: "run-5",
          startedAt: new Date(0).toISOString(),
          message: { text: "go", origin: { kind: "user" } },
          responseParts: [
            {
              kind: "inputRequest",
              request: {
                id: "run-5:call-1",
                message: "question",
                _meta: { productRequest: { callId: "call-1", questions: [{ id: "q1" }] } },
              },
            },
          ],
          usage: undefined,
        },
      }),
      "agent-1",
    );
    expect(view.transients["run-5"]?.ask).toEqual({ callId: "call-1", questions: [{ id: "q1" }] });
    expect(view.transients["run-5"]?.approval).toBeUndefined();
  });
});
