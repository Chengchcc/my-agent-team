import { describe, expect, test } from "bun:test";
import { formatDuration, formatDurationMs } from "./duration";

describe("formatDuration", () => {
  test("under a minute stays in seconds", () => {
    expect(formatDuration(49)).toBe("49s");
  });
  test("minutes and hours carry two units", () => {
    expect(formatDuration(3_605)).toBe("1h 0m");
    expect(formatDuration(43_299)).toBe("12h 1m");
  });
  test("a zombie execution shows its days", () => {
    expect(formatDuration(3_600_538)).toBe("41d 16h");
  });
  test("milliseconds and garbage", () => {
    expect(formatDurationMs(125_000)).toBe("2m 5s");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});
