import { describe, expect, test } from "bun:test";
import type { Message } from "@chengchenccc/message";
import { buildSummarizationRequest, serializeConversation } from "./compaction-prompt.js";

function msg(role: Message["role"], parts: Partial<Message>): Message {
  return { role, ...parts } as Message;
}

describe("serializeConversation", () => {
  test("tags roles and renders text, tool calls and tool results", () => {
    const out = serializeConversation([
      msg("user", { text: "read a.ts" }),
      msg("assistant", {
        blocks: [
          { type: "text", text: "Sure." },
          { type: "tool_use", id: "c1", name: "read", input: { path: "a.ts" } },
        ],
      }),
      msg("tool", {
        blocks: [{ type: "tool_result", tool_use_id: "c1", content: "export const a = 1;" }],
      }),
    ]);

    expect(out).toContain("[user]\nread a.ts");
    expect(out).toContain("[assistant]\nSure.");
    expect(out).toContain('[tool_use read] {"path":"a.ts"}');
    expect(out).toContain("[tool]\n  [tool_result] export const a = 1;");
  });

  test("marks failing results and never renders thinking", () => {
    const out = serializeConversation([
      msg("assistant", {
        blocks: [
          { type: "thinking", text: "SECRET REASONING", signature: "sig" },
          { type: "tool_use", id: "c1", name: "bash", input: { command: "false" } },
        ],
      }),
      msg("tool", {
        blocks: [
          {
            type: "tool_result",
            tool_use_id: "c1",
            content: "exit 1",
            is_error: true,
          },
        ],
      }),
    ]);

    // ThinkingBlock's contract: never rendered as conversation text.
    expect(out).not.toContain("SECRET REASONING");
    expect(out).not.toContain("sig");
    expect(out).toContain("[tool_result (error)] exit 1");
  });

  test("summarizes images as markers, not as base64 payloads", () => {
    const out = serializeConversation([
      msg("user", {
        blocks: [{ type: "image", mediaType: "image/png", base64: "AAAABBBBCCCC" }],
      }),
    ]);

    expect(out).toContain("[image image/png]");
    expect(out).not.toContain("AAAABBBBCCCC");
  });

  test("an unserializable tool input degrades instead of throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const out = serializeConversation([
      msg("assistant", { blocks: [{ type: "tool_use", id: "c1", name: "x", input: cyclic }] }),
    ]);

    expect(out).toContain("[tool_use x] [unserializable input]");
  });
});

describe("buildSummarizationRequest", () => {
  test("wraps the transcript as data between two messages", () => {
    const request = buildSummarizationRequest([msg("user", { text: "hello" })]);

    expect(request).toHaveLength(2);
    expect(request[0]?.role).toBe("system");
    expect(request[0]?.text).toContain("later turn can rely on");
    const user = request[1]?.text ?? "";
    // The wrapper is the whole point: it tells the model this is a document to
    // read, not a conversation to continue.
    expect(user).toContain("<conversation>\n[user]\nhello\n</conversation>");
    expect(request[1]?.role).toBe("user");
  });

  test("an empty transcript still produces a well-formed request", () => {
    const request = buildSummarizationRequest([]);
    expect(request[1]?.text).toContain("<conversation>\n\n</conversation>");
  });
});
