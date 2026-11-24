import { describe, expect, test } from "bun:test";
import { windowAround } from "./GlobalSearch";

/** The search hit's detail line: the match must be inside the window, or four
 *  hits on the same message stay indistinguishable (audit 2026-11-24). */
describe("search snippet window", () => {
  test("a short message is shown whole", () => {
    expect(windowAround("fix the login retry", "retry")).toBe("fix the login retry");
  });

  test("a long message is cut around the match", () => {
    const text = `${"a".repeat(200)} NEEDLE ${"b".repeat(200)}`;
    const out = windowAround(text, "needle");
    expect(out).toContain("NEEDLE");
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThan(200);
  });

  test("no match falls back to the head", () => {
    expect(windowAround(`${"x".repeat(300)}`, "zzz").endsWith("…")).toBe(true);
  });
});
