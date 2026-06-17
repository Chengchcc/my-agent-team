import { describe, expect, test } from "bun:test";
import { extractText } from "../../src/lib/timeline";

describe("extractText", () => {
  test("extracts text from text field", () => {
    expect(extractText({ text: "plain string" })).toBe("plain string");
  });

  test("extracts text from ContentBlock array", () => {
    const blocks = [
      { type: "text", text: "Hello " },
      { type: "tool_use", id: "1", name: "read", input: {} },
      { type: "text", text: "world" },
    ];
    expect(extractText({ blocks })).toBe("Hello  world");
  });

  test("returns empty string for no text blocks", () => {
    const blocks = [
      { type: "tool_use", id: "1", name: "read", input: {} },
      { type: "tool_result", tool_use_id: "1", content: "data" },
    ];
    expect(extractText({ blocks })).toBe("");
  });
});
