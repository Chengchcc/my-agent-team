import { describe, expect, test } from "bun:test";
import { runIdOfSource } from "./timeline";

describe("runIdOfSource", () => {
  test("a run-authored id yields the run", () => {
    expect(runIdOfSource("run:r123:assistant:4")).toBe("r123");
    expect(runIdOfSource("run:r123:tool:0")).toBe("r123");
  });

  test("human and cross-agent messages carry no run", () => {
    // Live-found: reading `content.id` (a field that does not exist) made this
    // null everywhere and silently disabled the dispatch tree + artifacts.
    expect(runIdOfSource("msg:conv:user:abc")).toBeNull();
    expect(runIdOfSource("input:hello")).toBeNull();
    expect(runIdOfSource(null)).toBeNull();
  });
});
