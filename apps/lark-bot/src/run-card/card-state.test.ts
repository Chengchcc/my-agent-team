/** The card's state as the chat channel has it. These vectors are the contract the run-card
 *  watcher will read from once it stops consuming the run stream: what the run is doing is
 *  whatever its turn says, and nothing here guesses. */
import { describe, expect, test } from "bun:test";
import type { ChatState } from "@microsoft/agent-host-protocol";
import { cardStateFromChatTurn } from "./card-state.js";

const markdown = (content: string, id = "t0") => ({ kind: "markdown", id, content });

const state = (over: Record<string, unknown>): ChatState =>
  ({
    resource: "ahp-chat:/c1",
    title: "t",
    status: 1,
    modifiedAt: new Date(0).toISOString(),
    turns: [],
    ...over,
  }) as ChatState;

const active = (parts: unknown[], id = "run-1") => ({
  id,
  startedAt: new Date(0).toISOString(),
  message: { text: "go", origin: { kind: "user" } },
  responseParts: parts,
  usage: undefined,
});

describe("the card state from a chat turn", () => {
  test("a streaming turn is its own markdown", () => {
    const card = cardStateFromChatTurn(
      state({ activeTurn: active([markdown("he", "t0"), markdown("llo", "t0")]) }),
      "run-1",
    );
    expect(card).toMatchObject({ output: "hello", phase: "streaming", terminal: null });
    expect(card?.pendingAction).toBeNull();
  });

  test("tool calls become steps: one running, the finished ones archived", () => {
    const card = cardStateFromChatTurn(
      state({
        activeTurn: active([
          {
            kind: "toolCall",
            toolCall: {
              toolCallId: "c1",
              toolName: "bash",
              displayName: "bash",
              status: "completed",
              success: true,
              invocationMessage: "reading the log",
              pastTenseMessage: "bash finished",
            },
          },
          {
            kind: "toolCall",
            toolCall: {
              toolCallId: "c2",
              toolName: "glob",
              displayName: "glob",
              status: "running",
              invocationMessage: "looking for config",
            },
          },
        ]),
      }),
      "run-1",
    );
    expect(card?.completedTools).toEqual([{ label: "reading the log", outcome: "success" }]);
    expect(card).toMatchObject({
      phase: "tool_running",
      activeTool: { label: "looking for config" },
    });
  });

  test("a failed tool is not a success", () => {
    const card = cardStateFromChatTurn(
      state({
        activeTurn: active([
          {
            kind: "toolCall",
            toolCall: {
              toolCallId: "c1",
              toolName: "bash",
              displayName: "bash",
              status: "completed",
              success: false,
              invocationMessage: "reading the log",
            },
          },
        ]),
      }),
      "run-1",
    );
    expect(card?.completedTools).toEqual([{ label: "reading the log", outcome: "error" }]);
  });

  test("an open request puts buttons on the card; an answered one does not", () => {
    const request = {
      kind: "inputRequest",
      request: {
        id: "run-1:call-9",
        message: "approval",
        _meta: {
          productRequest: {
            callId: "call-9",
            toolName: "bash",
            input: { command: "rm -rf x" },
            sandboxed: false,
          },
        },
      },
    };
    const open = cardStateFromChatTurn(state({ activeTurn: active([request]) }), "run-1");
    expect(open?.waiting).toBe("approval");
    expect(open?.pendingAction).toMatchObject({
      callId: "call-9",
      kind: "approval",
      toolName: "bash",
    });
    expect(open?.pendingAction?.prompt).toContain("rm -rf x");

    const answered = cardStateFromChatTurn(
      state({ activeTurn: active([{ ...request, response: "accept" }]) }),
      "run-1",
    );
    expect(answered?.pendingAction).toBeNull();
    expect(answered?.waiting).toBeNull();
  });

  test("a question arrives with its options and free-text row", () => {
    const card = cardStateFromChatTurn(
      state({
        activeTurn: active([
          {
            kind: "inputRequest",
            request: {
              id: "run-1:call-1",
              message: "ask",
              _meta: {
                productRequest: {
                  callId: "call-1",
                  questions: [
                    {
                      id: "q1",
                      question: "where?",
                      allowOther: true,
                      options: [{ label: "root", value: "root" }],
                    },
                  ],
                },
              },
            },
          },
        ]),
      }),
      "run-1",
    );
    expect(card?.pendingAction).toMatchObject({
      kind: "ask",
      callId: "call-1",
      prompt: "where?",
      questionId: "q1",
      allowFreeText: true,
      options: [{ label: "root", value: "root" }],
    });
  });

  test("the plan strip is the chat state's own todos", () => {
    const card = cardStateFromChatTurn(
      state({
        activeTurn: active([markdown("working")]),
        _meta: { todos: [{ id: "1", text: "step", status: "in_progress" }] },
      }),
      "run-1",
    );
    expect(card?.todos).toEqual([{ id: "1", text: "step", status: "in_progress" }]);
  });

  test("a folded turn is settled, and a failure keeps its message", () => {
    const done = cardStateFromChatTurn(
      state({
        turns: [
          {
            id: "run-1",
            startedAt: new Date(0).toISOString(),
            message: { text: "go", origin: { kind: "user" } },
            responseParts: [markdown("answer")],
            usage: undefined,
            state: "complete",
          },
        ],
      }),
      "run-1",
    );
    expect(done).toMatchObject({
      terminal: { status: "completed", error: null },
      output: "answer",
    });

    const failed = cardStateFromChatTurn(
      state({
        turns: [
          {
            id: "run-1",
            startedAt: new Date(0).toISOString(),
            message: { text: "go", origin: { kind: "user" } },
            responseParts: [{ kind: "error", error: { errorType: "run_failed", message: "boom" } }],
            usage: undefined,
            state: "error",
          },
        ],
      }),
      "run-1",
    );
    expect(failed).toMatchObject({ terminal: { status: "failed", error: "boom" } });
  });

  test("a run the state does not know gives no card", () => {
    expect(cardStateFromChatTurn(state({}), "run-1")).toBeUndefined();
  });
});
