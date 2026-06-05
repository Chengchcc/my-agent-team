import { describe, expect, test } from "bun:test";
import type { Message } from "@my-agent-team/core";
import { consoleLogger } from "../logger.js";
import { slidingWindowContextManager } from "./sliding-window.js";

const ctx = {
  threadId: "t1",
  logger: consoleLogger({ level: "silent" }),
  model: { stream: async function* () {} },
};

describe("slidingWindowContextManager", () => {
  test("keeps last N turns", async () => {
    const msgs: Message[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
    ];

    const result = await slidingWindowContextManager({ maxTurns: 2 }).shape(ctx, msgs);
    expect(result).toEqual([
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
    ]);
  });

  test("keepFirst preserves prefix", async () => {
    const msgs: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ];

    const result = await slidingWindowContextManager({ maxTurns: 1, keepFirst: 1 }).shape(
      ctx,
      msgs,
    );
    expect(result).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ]);
  });

  test("under limit → all preserved", async () => {
    const msgs: Message[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ];

    const result = await slidingWindowContextManager({ maxTurns: 5 }).shape(ctx, msgs);
    expect(result).toEqual(msgs);
  });

  test("does not mutate input", async () => {
    const msgs: Message[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
    ];
    const original = JSON.stringify(msgs);

    await slidingWindowContextManager({ maxTurns: 1 }).shape(ctx, msgs);
    expect(JSON.stringify(msgs)).toBe(original);
  });

  test("empty messages → empty result", async () => {
    const result = await slidingWindowContextManager({ maxTurns: 1 }).shape(ctx, []);
    expect(result).toEqual([]);
  });
});
