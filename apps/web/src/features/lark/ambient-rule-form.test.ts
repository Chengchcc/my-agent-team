import { describe, expect, test } from "bun:test";
import { deriveRuleId, ruleToWire, splitList } from "./ambient-rule-form";

const base = {
  id: "bugs",
  keyword: "deploy failed",
  mode: "record" as const,
  instruction: "",
  chats: [],
  senders: [],
};

describe("ambient rule form ↔ wire", () => {
  test("a null target is omitted, not sent as null (the route takes it as optional)", () => {
    const wire = ruleToWire({ ...base, agent: null });
    expect("agent" in wire).toBe(false);
  });

  test("an empty-string target is omitted too", () => {
    const wire = ruleToWire({ ...base, agent: "" });
    expect("agent" in wire).toBe(false);
  });

  test("a real target survives", () => {
    expect(ruleToWire({ ...base, agent: "guide" }).agent).toBe("guide");
  });

  test("ids split on commas (both widths) and whitespace", () => {
    expect(splitList("oc_a, oc_b，oc_c  oc_d")).toEqual(["oc_a", "oc_b", "oc_c", "oc_d"]);
    expect(splitList("   ")).toEqual([]);
  });

  test("the derived id is readable and bounded", () => {
    // CJK must survive the slug: it is a legit keyword language.
    expect(deriveRuleId("\u4e0a\u7ebf \u62a5\u9519!")).toBe("\u4e0a\u7ebf-\u62a5\u9519");
    expect(deriveRuleId("x".repeat(80)).length).toBe(40);
  });

  test("a keyword with nothing to keep falls back to a timestamp id", () => {
    expect(deriveRuleId("!!!", 0)).toBe("rule-0");
  });
});
