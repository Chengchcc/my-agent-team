/** Vectors for the chat-action translator. The event shapes here are the ones a real run emits -
 *  captured from a live backend (`{"type":"text_delta","text":"…"}`), not hand-invented: the first
 *  version of this suite built its own `{type, payload}` events, so it certified a translator that
 *  matched nothing at runtime. */
import { describe, expect, test } from "bun:test";
import { type ChatState, chatReducer, type Turn } from "@microsoft/agent-host-protocol";
import { createChatActionTranslator } from "./run-events.js";

const types = (actions: readonly { type: unknown }[]) => actions.map((a) => String(a.type));

describe("run events to chat actions", () => {
  test("the first delta opens its part, later ones only append", () => {
    const translator = createChatActionTranslator();
    const first = translator.translate("run-1", { type: "text_delta", text: "He" });
    expect(types(first)).toEqual(["chat/responsePart", "chat/delta"]);
    const second = translator.translate("run-1", { type: "text_delta", text: "llo" });
    expect(types(second)).toEqual(["chat/delta"]);
    // Same part id the projection uses, so the streamed part and the final one are one object.
    expect(second[0]).toMatchObject({ partId: "run-1:text:0", content: "llo" });
  });

  test("the deltas a real run streams arrive as text, not as nothing", () => {
    const translator = createChatActionTranslator();
    // Verbatim from a live run with OMA_FAKE_TEXT_LINES streaming three lines.
    const captured = [
      "alpha bravo charlie streamed over three deltas\n",
      "second line of the reply\n",
      "third line of the reply\n",
    ];
    const contents = captured.flatMap((text) =>
      translator
        .translate("run-cap", { type: "text_delta", text })
        .filter((a) => String(a.type) === "chat/delta")
        .map((a) => (a as { content: string }).content),
    );
    expect(contents).toEqual(captured);
  });

  test("thinking opens a reasoning part and uses the reasoning action", () => {
    const translator = createChatActionTranslator();
    const actions = translator.translate("run-2", { type: "thinking_delta", text: "hmm" });
    expect(types(actions)).toEqual(["chat/responsePart", "chat/reasoning"]);
    expect(actions[0]).toMatchObject({ part: { kind: "reasoning", id: "run-2:reasoning:0" } });
  });

  test("a text run resumes in a new part after a tool call", () => {
    const translator = createChatActionTranslator();
    translator.translate("run-3", { type: "text_delta", text: "before" });
    const start = translator.translate("run-3", {
      type: "native_tool_started",
      toolName: "glob",
      callId: "call-1",
      activity: "Listing the workspace",
    });
    // Start alone leaves the part `streaming`, and the upstream reducer DROPS a
    // completion that arrives while it is streaming — the card then rendered every
    // finished tool as "（失败）" (live 2026-10-10). Ready carries the `confirmed`
    // that moves the part to `running`, which is what makes the completion land.
    expect(types(start)).toEqual(["chat/toolCallStart", "chat/toolCallReady"]);
    // `activity` is what the tool wanted the user to see; upstream keeps it as the intention.
    expect(start[0]).toMatchObject({
      toolCallId: "call-1",
      toolName: "glob",
      displayName: "glob",
      intention: "Listing the workspace",
    });
    expect(start[1]).toMatchObject({
      toolCallId: "call-1",
      intention: "Listing the workspace",
      invocationMessage: "Listing the workspace",
      confirmed: "not-needed",
    });
    const after = translator.translate("run-3", { type: "text_delta", text: "after" });
    // The tool call occupies a position among the turn's parts, and the projection numbers by
    // position - so the text after it is part 2, not part 1.
    expect(after.map((a) => String(a.type))).toEqual(["chat/responsePart", "chat/delta"]);
    expect(after[1]).toMatchObject({ partId: "run-3:text:2", content: "after" });
  });

  test("a tool result tells success from failure", () => {
    const translator = createChatActionTranslator();
    const ok = translator.translate("run-4", {
      type: "native_tool_completed",
      toolName: "glob",
      callId: "call-1",
      result: { content: "3 files" },
    });
    expect(ok[0]).toMatchObject({
      type: "chat/toolCallComplete",
      toolCallId: "call-1",
      result: { success: true, pastTenseMessage: "glob finished" },
    });
    const bad = translator.translate("run-4", {
      type: "native_tool_completed",
      toolName: "bash",
      callId: "call-2",
      result: { isError: true },
    });
    expect(bad[0]).toMatchObject({ result: { success: false, pastTenseMessage: "bash failed" } });
  });

  test("events a chat channel does not carry produce nothing", () => {
    const translator = createChatActionTranslator();
    expect(translator.translate("run-5", { type: "status", status: "running" })).toEqual([]);
    expect(
      translator.translate("run-5", { type: "backend.oma.message_start", payload: {} }),
    ).toEqual([]);
    expect(translator.translate("run-5", { type: "text_delta", text: "" })).toEqual([]);
  });

  test("a turn is opened once, carrying the identity of the message that started it", () => {
    const translator = createChatActionTranslator();
    const opening = {
      text: "hello",
      startedAt: "2026-09-29T00:00:00.000Z",
      messageId: "msg:c1:user:abc",
    };
    const opened = translator.openTurn("run-6", opening);
    expect(types(opened)).toEqual(["chat/turnStarted"]);
    expect(opened[0]).toMatchObject({ message: { _meta: { messageId: "msg:c1:user:abc" } } });
    expect(translator.openTurn("run-6", opening)).toEqual([]);
    // Without an id the opening is still valid; the commit re-states the message later.
    expect(
      translator.openTurn("run-12", { text: "hi", startedAt: "2026-09-29T00:00:00.000Z" })[0],
    ).toMatchObject({ message: { text: "hi" } });
  });

  test("the committed turn replaces the preview and folds into the history", () => {
    const translator = createChatActionTranslator();
    translator.openTurn("run-7", { text: "hello", startedAt: "2026-09-29T00:00:00.000Z" });
    // The real shapes are enum-typed; a vector states them the way the projection serializes them.
    const committed = {
      message: { text: "hello", origin: { kind: "user" }, _meta: { messageId: "m-1", seq: 4 } },
      responseParts: [
        {
          kind: "markdown",
          id: "run-7:text:0",
          content: "hi",
          _meta: { messageId: "m-2", seq: 5 },
        },
      ],
    } as unknown as Pick<Turn, "message" | "responseParts">;
    const actions = translator.commitTurn("run-7", committed, 1200, "completed");
    expect(types(actions)).toEqual(["chat/turnStarted", "chat/responsePart", "chat/turnComplete"]);
    // The message goes back with the ledger's coordinates, so the list keys it by row id.
    expect(actions[0]).toMatchObject({ message: { _meta: { messageId: "m-1", seq: 4 } } });
    expect(actions[1]).toMatchObject({ part: { id: "run-7:text:0", _meta: { seq: 5 } } });
    expect(actions[2]).toMatchObject({ duration: 1200 });
    // A stopped run folds as CANCELLED: `chat/turnComplete` carries no status, so a surface reading
    // the reduced state could not tell a stop from a success (a live card said 已完成 while the
    // canonical model said cancelled).
    const stopped = translator.commitTurn("run-7", committed, 1200, "aborted");
    expect(types(stopped)).toEqual(["chat/turnStarted", "chat/responsePart", "chat/turnCancelled"]);
  });

  test("a run nobody streamed is not re-stated at commit", () => {
    const translator = createChatActionTranslator();
    expect(
      translator.commitTurn(
        "run-8",
        {
          message: { text: "x", origin: { kind: "user" } },
          responseParts: [],
        } as unknown as Pick<Turn, "message" | "responseParts">,
        1200,
        "completed",
      ),
    ).toEqual([]);
  });

  test("a human input request arrives as a card part, once", () => {
    const translator = createChatActionTranslator();
    const approval = translator.translate("run-10", {
      type: "approval_requested",
      payload: { callId: "call-9", toolName: "bash", input: { command: "rm -rf build" } },
    });
    // Same id and shape the projection gives the part, so a surface renders one card either way.
    expect(approval).toMatchObject([
      {
        type: "chat/responsePart",
        turnId: "run-10",
        part: {
          kind: "inputRequest",
          request: {
            id: "run-10:call-9",
            message: "approval",
            _meta: {
              productRequest: {
                callId: "call-9",
                toolName: "bash",
                input: { command: "rm -rf build" },
              },
            },
          },
        },
      },
    ]);
    // The durable row is idempotent by id, so a replayed event must not put up a second card.
    expect(
      translator.translate("run-10", {
        type: "approval_requested",
        payload: { callId: "call-9", toolName: "bash" },
      }),
    ).toEqual([]);
  });

  test("an ask request says it is a question and carries its items", () => {
    const translator = createChatActionTranslator();
    const ask = translator.translate("run-11", {
      type: "ask_requested",
      payload: { callId: "call-1", questions: [{ id: "q1", question: "which?" }] },
    });
    expect(ask[0]).toMatchObject({
      part: {
        request: {
          id: "run-11:call-1",
          message: "ask",
          _meta: { productRequest: { callId: "call-1" } },
        },
      },
    });
  });

  test("a continuity record is announced as its own turn", () => {
    const translator = createChatActionTranslator();
    const turn = {
      startedAt: "2026-09-29T00:00:00.000Z",
      message: { text: "", origin: { kind: "systemNotification" } },
      responseParts: [
        {
          kind: "systemNotification",
          content: "This conversation continued in a new one.",
          _meta: { newConversationId: "c2", requestedByRunId: "run-1" },
        },
      ],
    } as unknown as Pick<Turn, "message" | "responseParts" | "startedAt">;
    const actions = translator.announceContinuity("continuity:9", turn);
    // No preview to fold, so no open either: nothing was streamed for it.
    expect(types(actions)).toEqual(["chat/turnStarted", "chat/responsePart", "chat/turnComplete"]);
    expect(actions[1]).toMatchObject({
      part: { _meta: { newConversationId: "c2", requestedByRunId: "run-1" } },
    });
  });

  test("an answered request is closed on the channel", () => {
    const translator = createChatActionTranslator();
    expect(translator.inputCompleted("run-12:call-1", "accept")).toMatchObject([
      { type: "chat/inputCompleted", requestId: "run-12:call-1", response: "accept" },
    ]);
    // A deadline is a refusal the surface can show, not silence.
    expect(translator.inputCompleted("run-12:call-2", "decline")).toMatchObject([
      { response: "decline" },
    ]);
  });

  test("a dropped run starts fresh instead of appending to its old part", () => {
    const translator = createChatActionTranslator();
    translator.translate("run-9", { type: "text_delta", text: "a" });
    translator.drop("run-9");
    const again = translator.translate("run-9", { type: "text_delta", text: "b" });
    expect(types(again)).toEqual(["chat/responsePart", "chat/delta"]);
  });
});

test("our action sequence reaches `completed` in the upstream reducer", () => {
  // The contract that matters is with upstream's reducer, not with ourselves: a
  // completion it ignores leaves the part `streaming`, and the card's step list
  // renders that as "（失败）". The state here is the minimum the chat channel
  // needs (turns/queue/status are what the reducer reads around the turn).
  const translator = createChatActionTranslator();
  const empty = {
    turns: [],
    queue: [],
    status: "idle",
    _meta: {},
  } as unknown as ChatState;
  const actions = [
    ...translator.openTurn("run-red", { startedAt: new Date().toISOString(), text: "go" }),
    ...translator.translate("run-red", {
      type: "native_tool_started",
      toolName: "bash",
      callId: "c1",
      activity: "运行命令：echo hi",
    }),
    ...translator.translate("run-red", {
      type: "native_tool_completed",
      toolName: "bash",
      callId: "c1",
      result: { content: "hi", isError: false },
    }),
  ];
  let state = empty;
  for (const action of actions) state = chatReducer(state, action as never);
  const part = (state.activeTurn?.responseParts ?? []).find((p) => p.kind === "toolCall") as
    | { toolCall: { status?: string; success?: boolean } }
    | undefined;
  expect(part?.toolCall.status).toBe("completed");
  expect(part?.toolCall.success).toBe(true);
});
