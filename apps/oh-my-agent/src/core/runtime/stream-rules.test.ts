import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadStreamRules } from "./stream-rules.js";

const tmp = `/tmp/stream-rules-test-${Math.random().toString(36).slice(2, 8)}`;
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("loadStreamRules", () => {
  test("loads rules with condition frontmatter; body is the message", () => {
    const dir = join(tmp, ".oma", "rules");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "no-box-leak.md"),
      "---\ncondition: Box::leak\n---\n\nNever use Box::leak in production.",
    );
    const rules = loadStreamRules(tmp);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.name).toBe("no-box-leak");
    expect(rules[0]?.pattern.source).toBe("Box::leak");
    expect(rules[0]?.pattern.flags).toBe("");
    expect(rules[0]?.message).toBe("Never use Box::leak in production.");
  });

  test("fail-open: missing dir, missing condition, empty body, invalid regex", () => {
    // missing dir entirely
    expect(loadStreamRules(tmp)).toEqual([]);

    const dir = join(tmp, ".oma", "rules");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "no-condition.md"), "---\nname: x\n---\n\nBody.");
    writeFileSync(join(dir, "empty-body.md"), "---\ncondition: foo\n---\n\n  ");
    writeFileSync(join(dir, "bad-regex.md"), "---\ncondition: '[unclosed'\n---\n\nBody.");
    writeFileSync(join(dir, "valid.md"), "---\ncondition: ok\n---\n\nKeep this one.");
    const rules = loadStreamRules(tmp);
    expect(rules.map((r) => r.name)).toEqual(["valid"]);
  });

  /** Two inputs loaded fine and then matched NOTHING: the pattern was taken
   *  from the raw `condition:` line, so it compiled with its YAML quotes, and
   *  the frontmatter anchor required bare LF, so a CRLF file dropped every
   *  rule silently. Neither surfaced an error. */
  test("a YAML-quoted pattern loads without its quotes", () => {
    const dir = join(tmp, ".oma", "rules");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "single.md"), "---\ncondition: 'foo|bar'\n---\n\nReminder.");
    writeFileSync(join(dir, "double.md"), '---\ncondition: "baz"\n---\n\nReminder.');
    const rules = loadStreamRules(tmp);
    expect(rules.map((r) => r.pattern.source)).toEqual(["baz", "foo|bar"]);
    // The real proof: it matches the bare text it was written for.
    expect(rules.find((r) => r.name === "single")?.pattern.test("bar")).toBe(true);
  });

  test("a CRLF rule file loads its rules", () => {
    const dir = join(tmp, ".oma", "rules");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "crlf.md"), "---\r\ncondition: leaked\r\n---\r\n\r\nDo not leak.\r\n");
    const rules = loadStreamRules(tmp);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.pattern.source).toBe("leaked");
    expect(rules[0]?.message).toBe("Do not leak.");
  });
});
