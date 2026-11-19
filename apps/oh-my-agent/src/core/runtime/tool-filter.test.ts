import { describe, expect, test } from "bun:test";
import { parseToolFilter, toolFilterAllows } from "./tool-filter.js";

describe("--tools filter (CLI)", () => {
  test("plain names are a whitelist; `!` entries are a blacklist", () => {
    expect(parseToolFilter("read,write")).toEqual({ allow: new Set(["read", "write"]) });
    expect(parseToolFilter("!bash")).toEqual({ deny: new Set(["bash"]) });
  });

  test("an EMPTY spec allows everything (the default run)", () => {
    // Uncovered until now: every caller passed a non-empty spec, so the "no
    // filter" path the default run takes was never exercised.
    expect(parseToolFilter("")).toEqual({});
    expect(parseToolFilter("  ,  ")).toEqual({});
    expect(toolFilterAllows({}, "bash")).toBe(true);
  });

  test("a whitelist allows only its names; a blacklist everything else", () => {
    expect(toolFilterAllows({ allow: new Set(["read"]) }, "read")).toBe(true);
    expect(toolFilterAllows({ allow: new Set(["read"]) }, "bash")).toBe(false);
    expect(toolFilterAllows({ deny: new Set(["bash"]) }, "read")).toBe(true);
    expect(toolFilterAllows({ deny: new Set(["bash"]) }, "bash")).toBe(false);
  });
});
