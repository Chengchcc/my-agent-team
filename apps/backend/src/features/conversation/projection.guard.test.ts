import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("P9 grep guard: no bare MessageState literals in projection", () => {
  test("projection.ts has no naked === 'done'/'error'/'streaming' on message state", () => {
    const src = readFileSync(new URL("./projection.ts", import.meta.url), "utf8");
    // MessageState literals must go through helpers (isTerminal/isOpen/isSucceeded).
    // Allow none of these bare comparisons on .state.
    expect(src).not.toMatch(/\.state\s*===\s*"(done|error|streaming|pending|waiting)"/);
  });
});
