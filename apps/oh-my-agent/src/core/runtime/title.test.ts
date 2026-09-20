import { describe, expect, test } from "bun:test";
import {
  buildTitleContext,
  isLowSignalTitleInput,
  normalizeGeneratedSummary,
  normalizeGeneratedTitle,
} from "./title.js";

describe("title", () => {
  test("buildTitleContext extracts most recent N turns", () => {
    const ctx = buildTitleContext(
      [
        { role: "user", text: "第一轮寒暄" },
        { role: "assistant", text: "" },
        { role: "user", text: "第二轮的实质问题是什么" },
        { role: "assistant", text: "" },
        { role: "user", text: "第三轮的实质问题" },
      ],
      2,
    );
    // Recent content wins; early greeting / empty thinking-filler turns must
    // not crowd out the substantive question that should produce a title.
    expect(ctx).toContain("第二轮的实质问题");
    expect(ctx).toContain("第三轮的实质问题");
    expect(ctx).not.toContain("第一轮寒暄");
  });

  test("isLowSignalTitleInput filters greetings", () => {
    expect(isLowSignalTitleInput("hi")).toBe(true);
    expect(isLowSignalTitleInput("hey hey")).toBe(true);
    expect(isLowSignalTitleInput("你好")).toBe(true);
    expect(isLowSignalTitleInput("ok")).toBe(true);
    expect(isLowSignalTitleInput("fix the login bug")).toBe(false);
    expect(isLowSignalTitleInput("add JWT authentication")).toBe(false);
  });

  test("normalizeGeneratedTitle strips XML tags and quotes", () => {
    expect(normalizeGeneratedTitle("<title>Fix login</title>")).toBe("Fix login");
    expect(normalizeGeneratedTitle('"Fix login"')).toBe("Fix login");
    expect(normalizeGeneratedTitle("「登录修复」")).toBe("登录修复");
  });

  test("normalizeGeneratedTitle reads the tag out of a combined title+summary reply", () => {
    // The prompt asks for two tags on their own lines; the old first-line-only
    // read would have swallowed the summary line into the title.
    expect(
      normalizeGeneratedTitle(
        "<title>Fix login</title>\n<summary>Tracing the OAuth callback.</summary>",
      ),
    ).toBe("Fix login");
    expect(
      normalizeGeneratedTitle(
        "<title>Fix login</title>\n<summary>Tracing the OAuth callback.</summary>\n<style>none</style>",
      ),
    ).toBe("Fix login");
  });

  test("normalizeGeneratedTitle rejects none/empty/overlong", () => {
    expect(normalizeGeneratedTitle("<title>none</title>")).toBeNull();
    expect(normalizeGeneratedTitle("none")).toBeNull();
    expect(normalizeGeneratedTitle("")).toBeNull();
    expect(normalizeGeneratedTitle("a".repeat(81))).toBeNull();
  });
});

describe("session summary (same ephemeral call as the title)", () => {
  test("extracts the summary tag and collapses it to one line", () => {
    expect(
      normalizeGeneratedSummary(
        "<title>Fix login</title>\n<summary>Tracing the OAuth callback.</summary>",
      ),
    ).toBe("Tracing the OAuth callback.");
    expect(normalizeGeneratedSummary("<summary>line one\n   line two</summary>")).toBe(
      "line one line two",
    );
  });

  test("a reply with no summary tag yields null, never the title", () => {
    // Older prompts (and weak models) answer title-only: the resume list must
    // fall back to title/preview rather than showing an invented sentence.
    expect(normalizeGeneratedSummary("<title>Fix login</title>")).toBeNull();
    expect(normalizeGeneratedSummary("Fix login")).toBeNull();
    expect(normalizeGeneratedSummary("<summary>none</summary>")).toBeNull();
    expect(normalizeGeneratedSummary("<summary>   </summary>")).toBeNull();
  });

  test("an overlong summary is clipped at a word boundary, not mid-word", () => {
    const long = `${"word ".repeat(60)}end`;
    const clipped = normalizeGeneratedSummary(`<summary>${long}</summary>`);
    expect(clipped).not.toBeNull();
    expect(clipped!.endsWith("…")).toBe(true);
    expect(clipped!.length).toBeLessThanOrEqual(241);
    expect(clipped!.slice(0, -1).trimEnd().endsWith("word")).toBe(true);
  });
});
