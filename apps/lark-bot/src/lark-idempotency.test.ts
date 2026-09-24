import { describe, expect, test } from "bun:test";
import { larkIdempotencyKey } from "./lark-idempotency.js";

describe("larkIdempotencyKey", () => {
  test("stays within Lark's 50-char cap for real tuples", () => {
    const key = larkIdempotencyKey(
      "166e745444864255a631fa9579",
      "run:ee24de115ce048f08a106352bb:assistant:0",
      593,
    );
    expect(key.length).toBeLessThanOrEqual(50);
    expect(key).toMatch(/^[0-9a-f]{40}$/);
  });

  test("deterministic across calls (at-least-once replays dedupe)", () => {
    expect(larkIdempotencyKey("c", "m", 1)).toBe(larkIdempotencyKey("c", "m", 1));
  });

  test("distinct tuples produce distinct keys", () => {
    const a = larkIdempotencyKey("c", "m", 1);
    const b = larkIdempotencyKey("c", "m", 2);
    const c = larkIdempotencyKey("c", "m", "seal");
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
