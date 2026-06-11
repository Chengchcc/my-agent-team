import { describe, expect, test } from "bun:test";
import { extractText } from "../../src/lib/timeline";

describe("extractText", () => {
  test("extracts text from string content", () => {
    expect(extractText("plain string")).toBe("plain string");
  });

  test("extracts text from ContentBlock array", () => {
    const blocks = [
      { type: "text", text: "Hello " },
      { type: "tool_use", id: "1", name: "read", input: {} },
      { type: "text", text: "world" },
    ];
    expect(extractText(blocks)).toBe("Hello world");
  });

  test("returns empty string for no text blocks", () => {
    const blocks = [
      { type: "tool_use", id: "1", name: "read", input: {} },
      { type: "tool_result", tool_use_id: "1", content: "data" },
    ];
    expect(extractText(blocks)).toBe("");
  });

  test("handles unknown array items gracefully", () => {
    expect(extractText([{ type: "unknown" }])).toBe("");
  });
});

describe("tool_use/tool_result pairing (integration)", () => {
  test("tool_use and tool_result pair by tool_use_id", () => {
    const blocks = [
      { type: "text", text: "Let me check" },
      {
        type: "tool_use",
        id: "tool_1",
        name: "read",
        input: { file: "test.txt" },
      },
      {
        type: "tool_result",
        tool_use_id: "tool_1",
        content: "file contents",
        is_error: false,
      },
      { type: "text", text: "Done" },
    ];

    const toolUses = blocks.filter((b) => b.type === "tool_use") as Array<{
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
    }>;
    const toolResults = new Map<string, { content: string; isError?: boolean }>();
    for (const b of blocks) {
      if (
        b.type === "tool_result" &&
        "tool_use_id" in b &&
        typeof b.tool_use_id === "string" &&
        typeof b.content === "string"
      ) {
        toolResults.set(b.tool_use_id, {
          content: b.content,
          isError: b.is_error,
        });
      }
    }

    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]?.id).toBe("tool_1");

    const result = toolResults.get("tool_1");
    expect(result).toBeDefined();
    expect(result?.content).toBe("file contents");
    expect(result?.isError).toBe(false);
  });

  test("tool_result with is_error is flagged", () => {
    const blocks = [
      {
        type: "tool_use",
        id: "err_1",
        name: "write",
        input: { file: "/root/x" },
      },
      {
        type: "tool_result",
        tool_use_id: "err_1",
        content: "Permission denied",
        is_error: true,
      },
    ];

    const toolResults = new Map<string, { content: string; isError?: boolean }>();
    for (const b of blocks) {
      if (
        b.type === "tool_result" &&
        "tool_use_id" in b &&
        typeof b.tool_use_id === "string" &&
        typeof b.content === "string"
      ) {
        toolResults.set(b.tool_use_id, {
          content: b.content,
          isError: b.is_error,
        });
      }
    }

    const result = toolResults.get("err_1");
    expect(result).toBeDefined();
    expect(result?.isError).toBe(true);
  });

  test("orphan tool_use without result", () => {
    const blocks = [
      {
        type: "tool_use",
        id: "orphan",
        name: "read",
        input: {},
      },
    ];

    const toolResults = new Map<string, unknown>();
    for (const b of blocks) {
      if (
        b.type === "tool_result" &&
        "tool_use_id" in b &&
        typeof (b as { tool_use_id?: unknown }).tool_use_id === "string"
      ) {
        toolResults.set((b as { tool_use_id: string }).tool_use_id, b);
      }
    }

    expect(toolResults.has("orphan")).toBe(false);
  });
});
