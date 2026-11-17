import { describe, expect, test } from "bun:test";
import { isOwnAgentRun } from "./ownership.js";

describe("ADR 0060 D3 run-card ownership", () => {
  test("the bot's own run gets a card", () => {
    expect(isOwnAgentRun("front", "front")).toBe(true);
  });

  test("a worker's run does not — its words would read as the front desk's", () => {
    expect(isOwnAgentRun("front", "coding-worker")).toBe(false);
  });

  test("an unknown owner keeps the card (a silent drop is worse than a label)", () => {
    expect(isOwnAgentRun("front", undefined)).toBe(true);
  });
});
