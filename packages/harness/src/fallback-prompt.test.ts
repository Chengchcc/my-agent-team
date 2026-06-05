import { describe, expect, test } from "bun:test";
import { fallbackSystemPrompt } from "./fallback-prompt.js";

describe("fallbackSystemPrompt", () => {
  test("includes workspace path in prompt", () => {
    const prompt = fallbackSystemPrompt("/home/user/workspace");
    expect(prompt).toInclude("/home/user/workspace");
  });

  test("mentions creation of config files", () => {
    const prompt = fallbackSystemPrompt("/ws");
    expect(prompt).toInclude("SOUL.md");
    expect(prompt).toInclude("write tool");
  });

  test("returns non-empty string", () => {
    const prompt = fallbackSystemPrompt("/tmp/test");
    expect(prompt.length).toBeGreaterThan(0);
  });
});
