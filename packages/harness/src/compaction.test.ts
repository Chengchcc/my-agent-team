import { describe, expect, test } from "bun:test";
import type { AIMessageChunk, ChatModel } from "@my-agent-team/core";
import { inMemoryCheckpointer } from "@my-agent-team/framework";
import { compactThread } from "./compaction.js";

function echoModel(text: string): ChatModel {
  return {
    id: "echo",
    async *stream(): AsyncIterable<AIMessageChunk> {
      yield { delta: { type: "text", text } };
      yield { done: true, stopReason: "end_turn" };
    },
  };
}

describe("compactThread", () => {
  test("keeps all messages when under keepRecent threshold", async () => {
    const model = echoModel("summary");
    const cp = inMemoryCheckpointer();
    const messages = Array.from({ length: 5 }, (_, i) => ({
      role: "user" as const,
      text: `message ${i}`,
    }));
    await cp.save("t1", messages);

    const result = await compactThread({
      model,
      checkpointer: cp,
      threadId: "t1",
      keepRecent: 10,
    });

    expect(result.result.originalCount).toBe(5);
    expect(result.result.compactedCount).toBe(5);
  });

  test("compacts messages when over threshold", async () => {
    const model = echoModel("This is a summary of the conversation.");
    const cp = inMemoryCheckpointer();
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: "user" as const,
      text: `message ${i}`,
    }));
    await cp.save("t1", messages);

    const result = await compactThread({
      model,
      checkpointer: cp,
      threadId: "t1",
      keepRecent: 10,
    });

    expect(result.result.originalCount).toBe(20);
    expect(result.result.compactedCount).toBe(11); // 1 summary + 10 recent
    expect(result.messages[0]!.text).toContain("summary");
  });
});
