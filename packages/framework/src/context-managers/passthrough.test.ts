import { describe, expect, test } from "bun:test";
import type { Message } from "@my-agent-team/core";
import { consoleLogger } from "../logger.js";
import { passthroughContextManager } from "./passthrough.js";

const ctx = {
  threadId: "t1",
  logger: consoleLogger({ level: "silent" }),
  model: { stream: async function* () {} },
};

describe("passthroughContextManager", () => {
  test("returns new array with same elements", async () => {
    const msgs: Message[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];

    const result = await passthroughContextManager().shape(ctx, msgs);

    expect(result).toEqual(msgs);
    expect(result).not.toBe(msgs);
  });

  test("does not mutate input", async () => {
    const msgs: Message[] = [{ role: "user", content: "hi" }];
    const original = [...msgs];

    await passthroughContextManager().shape(ctx, msgs);

    expect(msgs).toEqual(original);
  });
});
