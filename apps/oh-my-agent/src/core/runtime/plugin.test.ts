import { describe, expect, test } from "bun:test";
import { renderMeta, validatePlugins } from "./plugin.js";

/** validatePlugins is the fail-closed gate at Run start (agent-loop.ts): a
 *  collision it does not catch becomes a silently wrong tool table or a
 *  duplicated prompt section. Meta sections were the case it missed. */
describe("validatePlugins", () => {
  test("accepts distinct plugins, tools and meta sections", () => {
    expect(() =>
      validatePlugins([
        { name: "a", tools: [{ name: "t1" } as never], meta: [{ name: "m1", render: () => "1" }] },
        { name: "b", tools: [{ name: "t2" } as never], meta: [{ name: "m2", render: () => "2" }] },
      ]),
    ).not.toThrow();
  });

  test("rejects a duplicate plugin name", () => {
    expect(() => validatePlugins([{ name: "a" }, { name: "a" }])).toThrow(
      /Duplicate plugin name: a/,
    );
  });

  test("rejects a duplicate tool name across plugins", () => {
    expect(() =>
      validatePlugins([
        { name: "a", tools: [{ name: "same" } as never] },
        { name: "b", tools: [{ name: "same" } as never] },
      ]),
    ).toThrow(/Duplicate tool name: same/);
  });

  test("rejects a duplicate meta section (it would render twice, unnoticed)", () => {
    expect(() =>
      validatePlugins([
        { name: "a", meta: [{ name: "loop", render: () => "first" }] },
        { name: "b", meta: [{ name: "loop", render: () => "second" }] },
      ]),
    ).toThrow(/Duplicate meta section: loop/);
  });
});

describe("renderMeta", () => {
  test("renders one section per provider, in plugin order", () => {
    const out = renderMeta([
      { name: "a", meta: [{ name: "one", render: () => "1" }] },
      { name: "b", meta: [{ name: "two", render: () => "2" }] },
      { name: "c" },
    ]);
    expect(out).toBe("## one\n1\n\n## two\n2");
  });
});
