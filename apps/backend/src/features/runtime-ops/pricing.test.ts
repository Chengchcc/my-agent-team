import { describe, expect, test } from "bun:test";
import { estimateCost } from "./pricing.js";

describe("estimateCost", () => {
  // Price table: USD per 1M tokens.
  // opus-4: input $15, output $75 per 1M
  // sonnet-4: input $3, output $15 per 1M
  // haiku-4-5: input $1, output $5 per 1M

  test("returns cost for known model (opus-4)", () => {
    // 10k input + 1k output
    const cost = estimateCost("claude-opus-4-7", { input: 10000, output: 1000 });
    // (10k * 15 + 1k * 75) / 1M = (150k + 75k) / 1M = 0.225
    expect(cost).toBeCloseTo(0.225, 6);
  });

  test("returns cost for known model (sonnet-4)", () => {
    const cost = estimateCost("claude-sonnet-4-6", { input: 10000, output: 1000 });
    // (10k * 3 + 1k * 15) / 1M = (30k + 15k) / 1M = 0.045
    expect(cost).toBeCloseTo(0.045, 6);
  });

  test("prefix matches shorter model id", () => {
    const cost = estimateCost("claude-sonnet-4-20250514", { input: 10000, output: 1000 });
    expect(cost).toBeCloseTo(0.045, 6);
  });

  test("returns null for unknown model", () => {
    const cost = estimateCost("unknown", { input: 1000, output: 500 });
    expect(cost).toBeNull();
  });

  test("returns null for empty model", () => {
    const cost = estimateCost("", { input: 1000, output: 500 });
    expect(cost).toBeNull();
  });

  test("includes cache tokens in cost", () => {
    const cost = estimateCost("claude-sonnet-4", {
      input: 10000,
      output: 1000,
      cacheRead: 5000,
      cacheCreate: 2000,
    });
    // (10k*3 + 1k*15 + 5k*0.3 + 2k*3.75) / 1M =
    // (30k + 15k + 1.5k + 7.5k) / 1M = 54k / 1M = 0.054
    expect(cost).toBeCloseTo(0.054, 6);
  });

  test("handles small token counts", () => {
    const cost = estimateCost("claude-haiku-4-5", { input: 100, output: 50 });
    // (100*1 + 50*5) / 1M = 350 / 1M = 0.00035
    expect(cost).toBeCloseTo(0.00035, 6);
  });
});
