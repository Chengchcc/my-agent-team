import { describe, expect, test } from "bun:test";
import type { Message } from "@my-agent-team/core";
import { consoleLogger } from "../logger.js";
import { summarizingContextManager } from "./summarizing.js";

const ctx = {
  threadId: "t1",
  logger: consoleLogger({ level: "silent" }),
  model: { stream: async function* () {} },
};

function msgs(count: number): Message[] {
  const m: Message[] = [];
  for (let i = 0; i < count; i++) {
    m.push({ role: "user", content: `msg-${i}` });
    m.push({ role: "assistant", content: `resp-${i}` });
  }
  return m;
}

describe("summarizingContextManager", () => {
  test("passes through when under trigger", async () => {
    const messages = msgs(3);
    const result = await summarizingContextManager({
      triggerAt: 1_000_000,
      keepRecent: 2,
      countTokens: () => 100,
    }).shape(ctx, messages);

    expect(result).toEqual(messages);
  });

  test("calls custom summarizer when over trigger", async () => {
    const messages = msgs(20);
    let summarizerCalled = false;

    const result = await summarizingContextManager({
      triggerAt: 10,
      keepRecent: 2,
      summarizer: async (old) => {
        summarizerCalled = true;
        return { role: "user", content: `[Summary of ${old.length} msgs]` };
      },
      countTokens: () => 1000,
    }).shape(ctx, messages);

    expect(summarizerCalled).toBe(true);
    // result should have: summary + last 2 messages (keepRecent=2)
    expect(result[0]?.content).toContain("[Summary");
    expect(result.length).toBe(3);
  });

  test("empty old → passes through even when over trigger", async () => {
    const messages = msgs(2);
    const result = await summarizingContextManager({
      triggerAt: 1,
      keepRecent: 10,
      countTokens: () => 1000,
    }).shape(ctx, messages);

    // keepRecent=10 covers all messages, old is empty → passthrough
    expect(result).toEqual(messages);
  });
});
