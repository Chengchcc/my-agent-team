import { describe, expect, test } from "bun:test";
import type { Message } from "@my-agent-team/core";
import { createThread } from "./thread.js";

describe("createThread", () => {
  test("creates a thread with id and empty messages", () => {
    const thread = createThread();

    expect(typeof thread.id).toBe("string");
    expect(thread.id.length).toBeGreaterThan(0);
    expect(thread.messages).toEqual([]);
  });

  test("accepts initial messages", () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const thread = createThread(messages);

    expect(thread.messages).toEqual(messages);
  });

  test("messages is mutable", () => {
    const thread = createThread();

    thread.messages.push({ role: "user", content: "hello" });

    expect(thread.messages).toHaveLength(1);
  });
});
