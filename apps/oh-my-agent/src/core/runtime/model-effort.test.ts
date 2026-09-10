import { describe, expect, test } from "bun:test";
import { normalizeReasoningEffort, reasoningEffortOptions } from "./model-effort.js";

describe("reasoning effort mapping", () => {
  test("product rungs map onto provider options", () => {
    expect(reasoningEffortOptions("none")).toEqual({ thinking: { type: "disabled" } });
    expect(reasoningEffortOptions("low")).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      effort: "low",
    });
    expect(reasoningEffortOptions("high")).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      effort: "high",
    });
    // "max" is the product's top rung; the provider's is "xhigh".
    expect(reasoningEffortOptions("max")).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      effort: "xhigh",
    });
  });

  test("unknown/absent = provider default (no thinking key at all)", () => {
    expect(reasoningEffortOptions(undefined)).toEqual({});
    expect(reasoningEffortOptions("")).toEqual({});
    expect(reasoningEffortOptions("medium")).toEqual({});
    expect(reasoningEffortOptions("XHIGH")).toEqual({});
  });

  test("normalize narrows untrusted values instead of failing the Run", () => {
    expect(normalizeReasoningEffort("max")).toBe("max");
    expect(normalizeReasoningEffort("medium")).toBeUndefined();
    expect(normalizeReasoningEffort("")).toBeUndefined();
    expect(normalizeReasoningEffort(null)).toBeUndefined();
    expect(normalizeReasoningEffort(3)).toBeUndefined();
  });
});
