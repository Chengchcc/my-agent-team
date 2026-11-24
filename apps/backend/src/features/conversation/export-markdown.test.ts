import { describe, expect, test } from "bun:test";
import { renderRevision } from "./export-markdown.js";

describe("the export renders blocks, not JSON", () => {
  test("a text block is text", () => {
    expect(renderRevision({ role: "assistant", blocks: [{ type: "text", text: "done" }] })).toBe(
      "done",
    );
  });

  test("a tool call is one line and its result a clipped excerpt", () => {
    const out = renderRevision({
      blocks: [
        { type: "tool_use", name: "bash", input: { command: "ls -la" } },
        { type: "tool_result", content: "x".repeat(1000) },
      ],
    });
    expect(out).toContain('`→ bash {"command":"ls -la"}`');
    expect(out).toContain("← xxxx");
    expect(out.length).toBeLessThan(700);
    expect(out).not.toContain("messageId");
  });

  test("a failed result is marked", () => {
    expect(
      renderRevision({ blocks: [{ type: "tool_result", content: "boom", isError: true }] }),
    ).toBe("> ✗ boom");
  });

  test("thinking is left out; a plain string and a top-level text pass through", () => {
    expect(renderRevision("hello")).toBe("hello");
    expect(renderRevision({ text: "top", blocks: [] })).toBe("top");
    expect(renderRevision({ blocks: [{ type: "thinking", text: "secret" }] })).toBe("");
  });
});
