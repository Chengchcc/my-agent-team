import { describe, expect, test } from "bun:test";
import { normalizeForLarkMarkdown } from "./markdown-normalizer.js";

describe("normalizeForLarkMarkdown", () => {
  test("normalizes \\r\\n to \\n", () => {
    const result = normalizeForLarkMarkdown("hello\r\nworld");
    expect(result.markdown).toContain("hello\nworld");
    expect(result.markdown).not.toContain("\r");
  });

  test("normalizes \\r to \\n", () => {
    const result = normalizeForLarkMarkdown("hello\rworld");
    expect(result.markdown).toContain("hello\nworld");
    expect(result.markdown).not.toContain("\r");
  });

  test("closes unclosed fenced code block", () => {
    const result = normalizeForLarkMarkdown("```\nsome code");
    expect(result.markdown).toContain("```");
    const fenceCount = (result.markdown.match(/^```/gm) ?? []).length;
    expect(fenceCount % 2).toBe(0);
  });

  test("does not close already-closed code block", () => {
    const result = normalizeForLarkMarkdown("```\ncode\n```");
    const fenceCount = (result.markdown.match(/^```/gm) ?? []).length;
    expect(fenceCount % 2).toBe(0);
  });

  test("truncates lines exceeding max line chars", () => {
    const longLine = "a".repeat(2500);
    const result = normalizeForLarkMarkdown(longLine);
    expect(result.markdown.endsWith("…"));
  });

  test("truncates total length exceeding max markdown chars", () => {
    // Use many short lines to avoid per-line truncation (2000 chars/line)
    // but exceed total max (12000 chars). Each line is "a\n".
    const longText = "a\n".repeat(13000);
    const result = normalizeForLarkMarkdown(longText);
    expect(result.truncated).toBe(true);
    expect(result.markdown).toContain("内容过长");
    expect(result.markdown).toContain("Web 端查看");
    expect(result.markdown.length).toBeGreaterThan(12000);
  });

  test("converts image markdown to link", () => {
    const result = normalizeForLarkMarkdown("![alt](https://example.com/img.png)");
    expect(result.markdown).toContain("[alt](https://example.com/img.png)");
    expect(result.markdown).not.toContain("![");
  });

  test("escapes HTML entities", () => {
    const result = normalizeForLarkMarkdown("text with & < >");
    expect(result.markdown).toContain("&amp;");
    expect(result.markdown).toContain("&lt;");
    expect(result.markdown).toContain("&gt;");
  });

  test("tracks original and rendered char counts", () => {
    const input = "hello world";
    const result = normalizeForLarkMarkdown(input);
    expect(result.originalChars).toBe(input.length);
    expect(result.renderedChars).toBeGreaterThan(0);
  });

  test("does not truncate short content", () => {
    const result = normalizeForLarkMarkdown("short");
    expect(result.truncated).toBe(false);
  });

  test("handles empty input", () => {
    const result = normalizeForLarkMarkdown("");
    expect(result.markdown).toBe("");
    expect(result.originalChars).toBe(0);
  });
});
