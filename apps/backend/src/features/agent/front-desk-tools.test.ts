import { describe, expect, test } from "bun:test";
import { FRONT_DESK_DISABLED_TOOLS } from "./front-desk-tools.js";

describe("front desk tool boundary (ADR 0072/0074)", () => {
  test("write and code-execution tools are denied", () => {
    for (const tool of ["bash", "eval", "write", "edit"]) {
      expect(FRONT_DESK_DISABLED_TOOLS).toContain(tool);
    }
  });

  test("investigation tools are denied too - they were the slower bypass", () => {
    // Live: a repo-study request read its own empty workspace, failed every
    // attempt and never dispatched. With no file/web tools the only exit is
    // dispatch.
    for (const tool of [
      "read",
      "ls",
      "grep",
      "glob",
      "tree",
      "web_search",
      "web_fetch",
      "browser",
    ]) {
      expect(FRONT_DESK_DISABLED_TOOLS).toContain(tool);
    }
  });
});
