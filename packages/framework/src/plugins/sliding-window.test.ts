import { describe, expect, test } from "bun:test";
import type { Message } from "@my-agent-team/core";
import { slidingWindow } from "./sliding-window.js";

describe("slidingWindow", () => {
  test("keeps only last N turns", async () => {
    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "q3" },
      { role: "assistant", content: "a3" },
    ];

    const plugin = slidingWindow({ maxTurns: 2 });
    const result = await plugin.hooks.beforeModel?.({ threadId: "t" }, messages);

    // system + last 2 turns (q2+a2, q3+a3) = 5 messages
    expect(result).toHaveLength(5);
    expect(result?.[0]).toEqual({ role: "system", content: "sys" });
  });

  test("preserves system message even when turns exceed window", async () => {
    const messages: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ];

    const plugin = slidingWindow({ maxTurns: 0 });
    const result = await plugin.hooks.beforeModel?.({ threadId: "t" }, messages);

    // system only (0 turns)
    expect(result).toEqual([{ role: "system", content: "sys" }]);
  });

  test("returns all messages when under maxTurns", async () => {
    const messages: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];

    const plugin = slidingWindow({ maxTurns: 5 });
    const result = await plugin.hooks.beforeModel?.({ threadId: "t" }, messages);

    expect(result).toEqual(messages);
  });

  test("does not mutate original messages", async () => {
    const messages: Message[] = [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ];

    const plugin = slidingWindow({ maxTurns: 1 });
    plugin.hooks.beforeModel?.({ threadId: "t" }, messages);

    expect(messages).toHaveLength(2);
  });
});
