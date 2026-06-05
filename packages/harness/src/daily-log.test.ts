import { describe, expect, test } from "bun:test";
import { isoDate } from "./daily-log.js";

describe("isoDate", () => {
  test("formats date as YYYY-MM-DD", () => {
    // local-time constructor — isoDate uses getFullYear/getMonth/getDate (local tz)
    const d = new Date(2026, 5, 5); // June 5, 2026
    expect(isoDate(d)).toBe("2026-06-05");
  });

  test("zero-pads month and day", () => {
    const d = new Date(2026, 0, 1); // January 1, 2026
    expect(isoDate(d)).toBe("2026-01-01");
  });

  test("handles end-of-year", () => {
    const d = new Date(2025, 11, 31, 23, 59, 59); // Dec 31, 2025 local time
    expect(isoDate(d)).toBe("2025-12-31");
  });
});
