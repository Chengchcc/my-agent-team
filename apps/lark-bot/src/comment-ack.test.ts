import { describe, expect, test } from "bun:test";
import type { CommentTarget } from "@larksuite/channel";
import { ackCommentProcessing, markCommentDone } from "./comment-ack.js";

const target: CommentTarget = { fileToken: "EWvsdouioonNMSxlY95m4uIly9w", fileType: "docx" };

interface Call {
  op: "add" | "remove";
  replyId: string;
  emoji?: string;
}

function fakeSurface(over: { addFails?: string; removeFails?: boolean } = {}) {
  const calls: Call[] = [];
  return {
    calls,
    surface: {
      addReaction: async (_t: CommentTarget, replyId: string, emoji?: string) => {
        calls.push({ op: "add", replyId, emoji });
        if (over.addFails === emoji) throw new Error("reaction refused");
      },
      removeReaction: async (_t: CommentTarget, replyId: string, emoji?: string) => {
        calls.push({ op: "remove", replyId, emoji });
        if (over.removeFails) throw new Error("nothing to remove");
      },
    },
  };
}

describe("comment acknowledgement (ADR 0044)", () => {
  test("a passing trigger gets a processing reaction, so the line is not silent", async () => {
    const { calls, surface } = fakeSurface();
    expect(await ackCommentProcessing(surface, target, "reply-1")).toBe(true);
    expect(calls).toEqual([{ op: "add", replyId: "reply-1", emoji: "Typing" }]);
  });

  test("a refused acknowledgement is reported, never thrown", async () => {
    // Cosmetic: losing the run over a reaction would be absurd.
    const { surface } = fakeSurface({ addFails: "Typing" });
    expect(await ackCommentProcessing(surface, target, "reply-1")).toBe(false);
  });

  test("the terminal mark takes the acknowledgement back first", async () => {
    const { calls, surface } = fakeSurface();
    await markCommentDone(surface, target, "reply-1");
    // Same ordering rule as the chat lane's swapAckReaction.
    expect(calls).toEqual([
      { op: "remove", replyId: "reply-1", emoji: "Typing" },
      { op: "add", replyId: "reply-1", emoji: "DONE" },
    ]);
  });

  test("a retraction that fails still leaves the terminal mark", async () => {
    const { calls, surface } = fakeSurface({ removeFails: true });
    await markCommentDone(surface, target, "reply-1");
    expect(calls.map((c) => c.emoji)).toEqual(["Typing", "DONE"]);
  });

  test("a refused terminal mark is swallowed too (the answer already landed)", async () => {
    const { surface } = fakeSurface({ addFails: "DONE" });
    await markCommentDone(surface, target, "reply-1");
  });
});
