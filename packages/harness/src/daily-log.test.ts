import { describe, expect, test } from "bun:test";
import { isoDate } from "./daily-log.js";

describe("isoDate", () => {
  test("formats date as YYYY-MM-DD", () => {
    const d = new Date("2026-06-05T10:00:00Z");
    expect(isoDate(d)).toBe("2026-06-05");
  });

  test("zero-pads month and day", () => {
    const d = new Date("2026-01-01T00:00:00Z");
    expect(isoDate(d)).toBe("2026-01-01");
  });

  test("handles end-of-year", () => {
    const d = new Date("2025-12-31T23:59:59Z");
    expect(isoDate(d)).toBe("2025-12-31");
  });
});
