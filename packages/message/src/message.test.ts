import { describe, expect, test } from "bun:test";
import type { Message, MessageRole, MessageState } from "./message.js";

describe("Message (type-level)", () => {
  test("minimal Message — only role is required", () => {
    const msg: Message = { role: "user" };
    expect(msg.role).toBe("user");
    expect(msg.id).toBeUndefined();
    expect(msg.state).toBeUndefined();
    expect(msg.text).toBeUndefined();
    expect(msg.blocks).toBeUndefined();
  });

  test("full Message — all fields populated", () => {
    const msg: Message = {
      id: "run:r1:assistant:0",
      role: "assistant",
      author: { kind: "agent", id: "a1", displayName: "Bot" },
      state: "streaming",
      text: "Hello world",
      blocks: [{ type: "text", text: "Hello world" }],
      tools: [{ id: "t1", name: "read", state: "done" }],
      runId: "r1",
      conversationId: "c1",
      visibility: "conversation",
      createdAt: 1700000000000,
      updatedAt: 1700000001000,
    };
    expect(msg.id).toBe("run:r1:assistant:0");
    expect(msg.state).toBe("streaming");
    expect(msg.blocks).toHaveLength(1);
  });

  test("MessageRole allows all four values at type level", () => {
    const roles: MessageRole[] = ["system", "user", "assistant", "tool"];
    expect(roles).toHaveLength(4);
  });

  test("MessageState allows all five values at type level", () => {
    const states: MessageState[] = ["pending", "streaming", "waiting", "done", "error"];
    expect(states).toHaveLength(5);
  });

  test("text-only message (no blocks)", () => {
    const msg: Message = { role: "user", text: "plain text" };
    expect(msg.text).toBe("plain text");
    expect(msg.blocks).toBeUndefined();
  });

  test("blocks-only message (no text)", () => {
    const msg: Message = {
      role: "assistant",
      blocks: [{ type: "text", text: "from block" }],
    };
    expect(msg.blocks).toHaveLength(1);
    expect(msg.text).toBeUndefined();
  });
});
