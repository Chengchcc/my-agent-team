import { describe, expect, test } from "bun:test";
import { truncateAtParagraph } from "./truncation.js";

describe("truncation", () => {
  test("returns full text when under maxChars", () => {
    const result = truncateAtParagraph("short text", 100, 500);
    expect(result.content).toBe("short text");
    expect(result.nextOffset).toBeUndefined();
  });

  test("truncates at paragraph boundary", () => {
    const a = "A".repeat(100);
    const b = "B".repeat(100);
    const text = `${a}\n\n${b}`;

    const result = truncateAtParagraph(text, 50, 500);
    // Should break at the \n\n after 'a' block, which is at position 100
    expect(result.content.length).toBeGreaterThanOrEqual(50);
    expect(result.nextOffset).toBeGreaterThan(0);
  });

  test("hard truncation when no paragraph boundary in lookahead", () => {
    const text = "A".repeat(200); // no paragraph breaks

    const result = truncateAtParagraph(text, 80, 20);
    expect(result.content.length).toBe(80);
    expect(result.nextOffset).toBe(80);
  });

  test("fully loaded when text fits within maxChars", () => {
    const result = truncateAtParagraph("hello", 10, 500);
    expect(result.content).toBe("hello");
    expect(result.nextOffset).toBeUndefined();
  });

  test("breaks at nearest \\n\\n within lookahead window", () => {
    const prefix = "A".repeat(100);
    const suffix = "\n\nC".repeat(50);
    const text = prefix + suffix;

    // hardEnd = 110, lookahead from 110 finds next \n\n
    const result = truncateAtParagraph(text, 110, 300);
    expect(result.content).toContain("AAAA");
    expect(result.nextOffset).toBeGreaterThan(100);
    expect(result.nextOffset).toBeLessThan(120);
  });
});
