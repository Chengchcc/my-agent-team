/** The writer's decisions, driven by fake deps and no protocol: a turn is opened before its
 *  parts, a settled turn is stated from the projection, and the two announcements are exactly
 *  what the projection says. */
import { describe, expect, test } from "bun:test";
import type { StateAction } from "@microsoft/agent-host-protocol";
import { createAhpChatWriter } from "./chat-writer.js";

const settle = () => new Promise((r) => setTimeout(r, 0));

function fixture(over: { projected?: unknown } = {}) {
  const sent: Array<{ uri: string; action: Record<string, unknown> }> = [];
  let reads = 0;
  const writer = createAhpChatWriter({
    dispatch: async (uri, action: StateAction) => {
      sent.push({ uri, action: action as unknown as Record<string, unknown> });
    },
    projectedTurn: async () => (over.projected ?? null) as never,
    readRunTurnContext: async () => {
      reads++;
      return {
        conversationId: "c1",
        inputText: "go",
        messageId: "msg:c1:user:1",
        startedAt: "2026-09-29T00:00:00.000Z",
      };
    },
  });
  return {
    writer,
    sent,
    types: () => sent.map((entry) => String(entry.action.type)),
    reads: () => reads,
  };
}

describe("the chat channel writer", () => {
  test("opens the turn before streaming into it, and reads the context once", async () => {
    const f = fixture();
    f.writer.onLiveEvent("run-1", { type: "text_delta", text: "he" });
    f.writer.onLiveEvent("run-1", { type: "text_delta", text: "llo" });
    await settle();
    // Opening, the part's announcement, then one delta per event - in that order.
    expect(f.types()).toEqual([
      "chat/turnStarted",
      "chat/responsePart",
      "chat/delta",
      "chat/delta",
    ]);
    expect(f.sent[0]?.uri).toBe("ahp-chat:/c1");
    // The opening carries the ledger identity, so a surface's own item collapses onto it.
    expect(f.sent[0]?.action.message).toMatchObject({ _meta: { messageId: "msg:c1:user:1" } });
    expect(f.reads()).toBe(1);
  });

  test("a terminal status is not an action", async () => {
    const f = fixture();
    f.writer.onLiveEvent("run-1", { type: "status", status: "completed" });
    await settle();
    expect(f.sent).toEqual([]);
  });

  test("a committed turn is stated from the projection and folded", async () => {
    const f = fixture({
      projected: {
        startedAt: "2026-09-29T00:00:00.000Z",
        message: { text: "go", origin: { kind: "user" }, _meta: { messageId: "msg:c1:user:1" } },
        responseParts: [{ kind: "markdown", id: "run-1:text:0", content: "done" }],
      },
    });
    // The fold only speaks for a turn this writer streamed; a surface that never saw the preview
    // gets the turn from its own snapshot.
    f.writer.onLiveEvent("run-1", { type: "text_delta", text: "streaming" });
    await settle();
    const before = f.sent.length;

    await f.writer.foldCommittedTurn("run-1", 1200);
    const folded = f.sent.slice(before);
    expect(folded.map((entry) => String(entry.action.type))).toEqual([
      "chat/turnStarted",
      "chat/responsePart",
      "chat/turnComplete",
    ]);
    // The projection's own statement of the turn, not the preview's.
    expect(folded[1]?.action.part).toMatchObject({ content: "done" });
    expect(folded[2]?.action.duration).toBe(1200);
  });

  test("a turn this writer never opened is not restated", async () => {
    const f = fixture({
      projected: {
        startedAt: "2026-09-29T00:00:00.000Z",
        message: { text: "go", origin: { kind: "user" } },
        responseParts: [{ kind: "markdown", id: "run-1:text:0", content: "done" }],
      },
    });
    await f.writer.foldCommittedTurn("run-1", 1200);
    expect(f.sent).toEqual([]);
  });

  test("a turn the projection does not have is not restated", async () => {
    const f = fixture();
    f.writer.onLiveEvent("run-1", { type: "text_delta", text: "streaming" });
    await settle();
    const before = f.sent.length;
    await f.writer.foldCommittedTurn("run-1", 0);
    expect(f.sent.length).toBe(before);
  });

  test("an answered request closes on the channel with the product's own id", async () => {
    const f = fixture();
    await f.writer.announceHumanInput({ runId: "run-1", callId: "call-9", outcome: "allow" });
    expect(f.types()).toEqual(["chat/inputCompleted"]);
    expect(f.sent[0]?.action).toMatchObject({ requestId: "run-1:call-9", response: "accept" });
    await f.writer.announceHumanInput({ runId: "run-1", callId: "call-9", outcome: "timeout" });
    expect(f.sent[1]?.action).toMatchObject({ response: "decline" });
    // An ask answered with content reads as accepted; the answer's content comes with the
    // projection (mapping it onto upstream's answer kinds is a decision of its own).
    await f.writer.announceHumanInput({ runId: "run-1", callId: "call-2", outcome: "answered" });
    expect(f.sent[2]?.action).toMatchObject({ requestId: "run-1:call-2", response: "accept" });
  });

  test("a continuity record is announced as its own turn", async () => {
    const f = fixture({
      projected: {
        startedAt: "2026-09-29T00:00:00.000Z",
        message: { text: "", origin: { kind: "systemNotification" } },
        responseParts: [
          {
            kind: "systemNotification",
            content: "continued",
            _meta: { newConversationId: "c2", requestedByRunId: "run-1" },
          },
        ],
      },
    });
    await f.writer.announceContinuity({ conversationId: "c1", controlSeq: 9 });
    expect(f.types()).toEqual(["chat/turnStarted", "chat/responsePart", "chat/turnComplete"]);
    expect(f.sent[0]?.action.turnId).toBe("continuity:9");
    expect(f.sent[1]?.action.part).toMatchObject({
      _meta: { newConversationId: "c2", requestedByRunId: "run-1" },
    });
  });
});
