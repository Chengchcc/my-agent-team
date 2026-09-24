import { describe, expect, test } from "bun:test";
import { describeDrift, diffServedModels, parseServedModelIds } from "./model-discovery.js";

/** Captured verbatim from the live endpoints (2026-09-24). */
const DEEPSEEK_RESPONSE = {
  object: "list",
  data: [
    {
      id: "deepseek-flash",
      object: "model",
      owned_by: "deepseek",
      name: "DeepSeek-V4.1-Flash",
      context_window: 1048576,
      max_output_tokens: 393216,
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      effort: { supported_levels: ["low", "high", "max"], default_level: "high" },
    },
    { id: "deepseek-v4-pro", object: "model", owned_by: "deepseek" },
  ],
};

/** GLM / Z.AI answers the plain OpenAI shape: ids and nothing else. */
const GLM_RESPONSE = {
  object: "list",
  data: [
    { id: "glm-4.5", object: "model", created: 1753632000, owned_by: "z-ai" },
    { id: "glm-5.3-flash", object: "model", created: 1753632000, owned_by: "z-ai" },
  ],
};

describe("parseServedModelIds", () => {
  test("reads the rich shape (DeepSeek) and the plain one (GLM) alike", () => {
    expect(parseServedModelIds(DEEPSEEK_RESPONSE)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(parseServedModelIds(GLM_RESPONSE)).toEqual(["glm-4.5", "glm-5.3-flash"]);
  });

  test("drops entries without a usable id instead of inventing one", () => {
    const payload = { data: [{ id: "ok" }, { id: "" }, { object: "model" }, null, "str", 7] };
    expect(parseServedModelIds(payload)).toEqual(["ok"]);
  });

  test("an error body or a different shape yields no ids", () => {
    // A failed call must look like "we learned nothing", never like
    // "the provider serves no models" — the caller falls back to the
    // declared catalogue on an empty result.
    expect(parseServedModelIds({ error: { code: 401 } })).toEqual([]);
    expect(parseServedModelIds({ data: "nope" })).toEqual([]);
    expect(parseServedModelIds(null)).toEqual([]);
    expect(parseServedModelIds("html")).toEqual([]);
  });
});

describe("diffServedModels", () => {
  test("the shipped bug: a declared id the provider never served", () => {
    // This is `deepseek-v4-flash` — the catalog offered it, the provider
    // answered with `deepseek-flash`, and nothing compared the two.
    const drift = diffServedModels(
      ["deepseek-v4-flash", "deepseek-v4-pro"],
      ["deepseek-flash", "deepseek-v4-pro"],
    );
    expect(drift.unserved).toEqual(["deepseek-v4-flash"]);
    expect(drift.confirmed).toEqual(["deepseek-v4-pro"]);
    expect(drift.undeclared).toEqual(["deepseek-flash"]);
  });

  test("no drift when the catalogue matches", () => {
    const drift = diffServedModels(["a", "b"], ["b", "a"]);
    expect(drift).toEqual({ confirmed: ["a", "b"], unserved: [], undeclared: [] });
    expect(describeDrift("acme", drift)).toBe("");
  });

  test("a model the provider added shows up as undeclared, not as an error", () => {
    const drift = diffServedModels(["a"], ["a", "brand-new"]);
    expect(drift.undeclared).toEqual(["brand-new"]);
    expect(drift.unserved).toEqual([]);
  });

  test("describeDrift names both directions", () => {
    const line = describeDrift("deepseek", diffServedModels(["gone"], ["new"]));
    expect(line).toContain("deepseek");
    expect(line).toContain("declared but not served: gone");
    expect(line).toContain("served but not declared: new");
  });
});
