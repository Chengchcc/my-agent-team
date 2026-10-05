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

import { describe as d2, expect as e2, test as t2 } from "bun:test";

d2("mmt reminders add argument forms", () => {
  t2("--in is a flag: the documented relative form parses without a positional at", () => {
    const r = parseArgs(["reminders", "add", "c1", "hello", "--in", "60"]);
    e2(r.flags.in).toBe("60");
    e2(r.positional).toEqual(["add", "c1", "hello"]);
  });
});
