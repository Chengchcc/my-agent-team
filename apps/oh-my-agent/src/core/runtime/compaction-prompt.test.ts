import { describe, expect, test } from "bun:test";
import type { Message } from "@chengchenccc/message";
import {
  buildSummarizationRequest,
  collectFileOperations,
  type FileMarker,
  renderFileOperations,
  serializeConversation,
  upsertFileOperations,
} from "./compaction-prompt.js";

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

describe("file operations in summaries", () => {
  test("marks reads, writes, and files both touched", () => {
    const files = collectFileOperations([
      msg("assistant", {
        blocks: [{ type: "tool_use", id: "1", name: "read", input: { path: "a.ts" } }],
      }),
      msg("assistant", {
        blocks: [{ type: "tool_use", id: "2", name: "write", input: { path: "b.ts" } }],
      }),
      msg("assistant", {
        blocks: [
          { type: "tool_use", id: "3", name: "read", input: { path: "c.ts" } },
          { type: "tool_use", id: "4", name: "edit", input: { path: "c.ts" } },
        ],
      }),
    ]);

    expect([...files]).toEqual([
      ["a.ts", "read"],
      ["b.ts", "write"],
      ["c.ts", "rw"],
    ]);
  });

  test("ignores non-file tools and inputs without a usable path", () => {
    const files = collectFileOperations([
      msg("assistant", {
        blocks: [
          { type: "tool_use", id: "1", name: "bash", input: { command: "ls" } },
          { type: "tool_use", id: "2", name: "read", input: { path: "   " } },
        ],
      }),
    ]);

    expect(files.size).toBe(0);
    expect(renderFileOperations(files)).toBe("");
  });

  test("renders a sorted block, capped with an elision line", () => {
    const files = new Map<string, FileMarker>();
    for (let i = 0; i < 23; i++) files.set(`f${String(i).padStart(2, "0")}.ts`, "read");

    const block = renderFileOperations(files);

    expect(block.startsWith("<files>\nf00.ts (Read)")).toBe(true);
    expect(block).toContain("f19.ts (Read)");
    expect(block).not.toContain("f20.ts");
    expect(block).toContain("[…3 files elided…]");
  });

  test("upsert replaces a model-written block instead of stacking two", () => {
    const once = upsertFileOperations(
      "did the thing\n\n<files>\nstale.ts (Read)\n</files>",
      "<files>\nfresh.ts (Write)\n</files>",
    );

    expect(once).toBe("did the thing\n\n<files>\nfresh.ts (Write)\n</files>");
    expect(upsertFileOperations(once, "")).toBe("did the thing");
  });
});

describe("split-turn guidance", () => {
  test("both request shapes ask for the turn-context section", () => {
    const first = buildSummarizationRequest([msg("user", { text: "x" })])[1]?.text ?? "";
    const update =
      buildSummarizationRequest([msg("user", { text: "x" })], { previousSummary: "OLD" })[1]
        ?.text ?? "";

    for (const text of [first, update]) {
      expect(text).toContain("**Turn Context (split turn):**");
      expect(text).toContain("has\nnot finished");
    }
  });
});

describe("buildSummarizationRequest from the second compaction on", () => {
  test("carries the previous summary and asks for one summary covering both", () => {
    const request = buildSummarizationRequest([msg("user", { text: "new work" })], {
      previousSummary: "OLD SUMMARY",
    });

    const user = request[1]?.text ?? "";
    expect(user).toContain("<previous-summary>\nOLD SUMMARY\n</previous-summary>");
    expect(user).toContain("<conversation>\n[user]\nnew work\n</conversation>");
    // The reader never sees the split, so the update must not mention itself.
    expect(user).toContain("covering BOTH");
    expect(user).toContain("never mention that it updates an earlier one");
  });

  test("a blank previous summary falls back to the first-compaction shape", () => {
    const user =
      buildSummarizationRequest([msg("user", { text: "x" })], { previousSummary: "   " })[1]
        ?.text ?? "";

    expect(user).not.toContain("<previous-summary>");
  });
});
