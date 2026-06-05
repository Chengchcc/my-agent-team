import { describe, expect, test } from "bun:test";
import type { Message } from "@my-agent-team/core";
import { fileCheckpointer } from "./file-checkpointer.js";

describe("fileCheckpointer", () => {
  test("save and load round-trips messages", async () => {
    const path = `/tmp/test-checkpoint-${Date.now()}.json`;
    const cp = fileCheckpointer({ path });
    const messages: Message[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];

    await cp.save("thread-1", messages);
    const loaded = await cp.load("thread-1");

    expect(loaded).toEqual(messages);
  });

  test("load returns null for non-existent thread", async () => {
    const path = `/tmp/test-checkpoint-empty-${Date.now()}.json`;
    const cp = fileCheckpointer({ path });

    const loaded = await cp.load("non-existent");

    expect(loaded).toBeNull();
  });
});
