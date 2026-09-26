import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { LARK_BOT_DEV_ENTRY } from "./lark-bot-registry-factory.js";

describe("dev lark-bot entry", () => {
  test("resolves to a file that exists", () => {
    // The path carries the repo layout, so its depth is part of the contract.
    // It was one level short: apps/apps/lark-bot/src/main.ts, and every dev bot
    // the backend spawned died with "Module not found" in a restart loop.
    expect(existsSync(LARK_BOT_DEV_ENTRY)).toBe(true);
  });
});
