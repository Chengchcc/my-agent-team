import { describe, expect, test } from "bun:test";
import { blockedHarnesses } from "./harness-availability";

describe("blockedHarnesses", () => {
  test("names a harness the registry does not know", () => {
    expect(blockedHarnesses([{ harness: "ghost" }], [{ key: "oma" }])).toEqual(["ghost"]);
  });

  test("says nothing when every enabled agent's harness is startable", () => {
    expect(
      blockedHarnesses(
        [{ harness: "oma" }, { harness: "claude" }],
        [{ key: "oma" }, { key: "claude" }],
      ),
    ).toEqual([]);
  });

  test("counts a harness whose own probe failed as unstartable", () => {
    expect(
      blockedHarnesses([{ harness: "claude" }], [{ key: "claude", error: "spawn failed" }]),
    ).toEqual(["claude"]);
  });

  test("ignores disabled agents", () => {
    expect(blockedHarnesses([{ harness: "ghost", enabled: false }], [])).toEqual([]);
  });

  test("reports each blocked harness once, sorted", () => {
    expect(
      blockedHarnesses([{ harness: "pi" }, { harness: "oma" }, { harness: "pi" }], []),
    ).toEqual(["oma", "pi"]);
  });
});
