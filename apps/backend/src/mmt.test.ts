import { describe, expect, test } from "bun:test";
import { parseArgs } from "./mmt.js";

describe("mmt arg parsing", () => {
  test("positionals and --flag value pairs split", () => {
    const r = parseArgs(["msg", "conv-1", "hello", "world", "--to", "coder"]);
    expect(r.cmd).toBe("msg");
    expect(r.positional).toEqual(["conv-1", "hello", "world"]);
    expect(r.flags).toEqual({ to: "coder" });
  });

  test("boolean flags take the literal true", () => {
    const r = parseArgs(["tasks", "--all"]);
    expect(r.flags.all).toBe("true");
  });

  test("empty argv yields an empty command (usage path)", () => {
    expect(parseArgs([]).cmd).toBe("");
    expect(parseArgs([]).positional).toEqual([]);
  });
});
