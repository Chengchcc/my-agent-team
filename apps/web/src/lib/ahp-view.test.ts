import { describe, expect, test } from "bun:test";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { chatViewFromState, itemsFromChatState } from "./ahp-view";

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

describe("the message list from AHP chat state", () => {
  const viewer = { memberId: "viewer", kind: "human" } as const;
  const agent = { memberId: "agent-1", kind: "agent", agentId: "agent-1" } as const;

  test("a finished turn yields its initiating message and its text, with the ledger ids", () => {
    const items = itemsFromChatState(
      state([
        {
          id: "run-1",
          state: "complete",
          message: {
            text: "hello",
            origin: { kind: "user" },
            _meta: { messageId: "msg-1", seq: 4 },
          },
          responseParts: [
            {
              kind: "markdown",
              id: "t0",
              content: "hi there",
              _meta: { messageId: "msg-2", seq: 5 },
            },
          ],
        },
      ]),
      viewer,
      agent,
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: "msg-1", seq: 4, sender: { kind: "human" } });
    expect(items[1]).toMatchObject({ id: "msg-2", seq: 5, sender: { kind: "agent" } });
    expect(items[1]?.kind === "message" ? items[1].content.text : "").toBe("hi there");
  });

  test("the turn in flight contributes no message item for its text", () => {
    const items = itemsFromChatState(
      state([], {
        activeTurn: {
          id: "run-2",
          startedAt: new Date(0).toISOString(),
          message: { text: "go", origin: { kind: "user" }, _meta: { messageId: "msg-3", seq: 6 } },
          responseParts: [{ kind: "markdown", id: "t0", content: "streaming…" }],
          usage: undefined,
        },
      }),
      viewer,
      agent,
    );
    // The input is real history; the streaming text is not a message yet.
    expect(items.map((item) => item.id)).toEqual(["msg-3"]);
  });
});

describe("undo", () => {
  test("an undone row's message is marked instead of vanishing", () => {
    const items = itemsFromChatState(
      state([
        {
          id: "run-7",
          state: "complete",
          message: {
            text: "oops",
            origin: { kind: "user" },
            _meta: { messageId: "msg-9", seq: 9, undone: true },
          },
          responseParts: [],
        },
      ]),
      { memberId: "viewer", kind: "human" },
      null,
    );
    expect(items[0]).toMatchObject({ id: "msg-9", seq: 9, undone: true });
  });
});

describe("system rows", () => {
  test("a notification part becomes a notice item, not a chat message", () => {
    const items = itemsFromChatState(
      state([
        {
          id: "run-8",
          state: "complete",
          message: { text: "", origin: { kind: "user" } },
          responseParts: [
            {
              kind: "systemNotification",
              content: "member joined",
              _meta: { messageId: "m-sys" },
            },
            { kind: "markdown", id: "t0", content: "hello", _meta: { messageId: "m-1", seq: 3 } },
          ],
        },
      ]),
      { memberId: "viewer", kind: "human" },
      null,
    );
    expect(items[0]).toEqual({ kind: "notice", id: "m-sys", text: "member joined" });
    expect(items[1]).toMatchObject({ kind: "message", id: "m-1" });
  });
});
