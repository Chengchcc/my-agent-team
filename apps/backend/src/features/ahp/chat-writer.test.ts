/** The writer's decisions, driven by fake deps and no protocol: a turn is opened before its
 *  parts, a settled turn is stated from the projection, and the two announcements are exactly
 *  what the projection says. */
import { describe, expect, test } from "bun:test";
import type { StateAction } from "@microsoft/agent-host-protocol";
import { createAhpChatWriter } from "./chat-writer.js";

const settle = () => new Promise((r) => setTimeout(r, 0));

function fixture(over: { projected?: unknown } = {}) {
  const sent: Array<{ uri: string; action: Record<string, unknown> }> = [];
  const invalidated: string[] = [];
  const savedImages: Array<{ mediaType: string; bytes: string }> = [];
  let reads = 0;
  const writer = createAhpChatWriter({
    dispatch: async (uri, action: StateAction) => {
      sent.push({ uri, action: action as unknown as Record<string, unknown> });
    },
    invalidate: (uri) => {
      invalidated.push(uri);
    },
    saveImage: async ({ mediaType, base64 }: { mediaType: string; base64: string }) => {
      savedImages.push({ mediaType, bytes: base64 });
      return {
        uri: `artifacts://tool-images/c1/shot.${mediaType.split("/")[1]}`,
        contentType: mediaType,
        size: 3,
      };
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
    invalidated,
    savedImages,
    types: () => sent.map((entry) => String(entry.action.type)),
    reads: () => reads,
  };
}

describe("the chat channel writer", () => {
  test("a tool's images are saved and reach the channel as references (#65)", async () => {
    const f = fixture();
    f.writer.onLiveEvent("run-1", {
      type: "native_tool_completed",
      toolName: "browser",
      callId: "call-1",
      result: { images: [{ type: "image", mediaType: "image/png", base64: "aWNn" }] },
    } as never);
    f.writer.onLiveEvent("run-1", {
      type: "native_tool_completed",
      toolName: "bash",
      callId: "call-2",
      result: { stdout: "no images here" },
    } as never);
    await settle();
    // The bytes were persisted, and the part that travels is only a reference.
    expect(f.savedImages).toEqual([{ mediaType: "image/png", bytes: "aWNn" }]);
    const withPart = f.sent.filter((entry) => entry.action.type === "chat/responsePart");
    expect(withPart).toHaveLength(1);
    expect(withPart[0]!.action).toMatchObject({
      turnId: "run-1",
      part: {
        kind: "contentRef",
        uri: "artifacts://tool-images/c1/shot.png",
        contentType: "image/png",
        sizeHint: 3,
      },
    });
  });

  test("a todo update drops the cached projection (no action can carry the plan strip)", async () => {
    const f = fixture();
    f.writer.onLiveEvent("run-1", {
      type: "backend.oma.todo_update",
      payload: { items: [{ id: "t1", text: "first", status: "in_progress" }] },
    } as never);
    await settle();
    // The field lives in `state._meta`, which only a snapshot can set, so the surface only sees
    // it after the cache is dropped (#52 step 1: AhpServer.invalidate).
    expect(f.invalidated).toEqual(["ahp-chat:/c1"]);
  });

  test("an undo drops the cached projection and dispatches nothing (#57)", async () => {
    const f = fixture();
    await f.writer.announceMessagesUndone("c1");
    // The projection KEEPS undone messages (flagged), so no action can state the change — a
    // truncation would remove turns the source still states. The flags ride the next snapshot.
    expect(f.invalidated).toEqual(["ahp-chat:/c1"]);
    expect(f.sent).toEqual([]);
  });

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
