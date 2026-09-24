import { describe, expect, test } from "bun:test";
import {
  BUILTIN_CATALOG,
  MODEL_ALIASES,
  parseCatalogYAML,
  resolveModelAlias,
} from "./model-catalog.js";

// parseCatalogYAML returns a loosely-typed structure; cast provider maps for
// assertions on keys beyond the strict ProviderSpec/ModelSpec contracts.
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v as Obj;

/** A catalogue entry by id, failing LOUDLY when it is gone: a test that reads
 *  `providers.zai` directly would otherwise compile-error under
 *  noUncheckedIndexedAccess (or worse, be guarded into silence). */
function provider(id: keyof typeof BUILTIN_CATALOG.providers) {
  const entry = BUILTIN_CATALOG.providers[id];
  if (!entry) throw new Error(`catalogue is missing the ${String(id)} provider`);
  return entry;
}

describe("parseCatalogYAML", () => {
  test("quoted scalars lose their surrounding quotes", () => {
    const cat = parseCatalogYAML(`providers:
  acme:
    api: openai
    baseUrl: "https://api.acme.test"
    apiKeyEnv: 'ACME_KEY'
    models:
      - id: gpt-x
        name: "GPT X-tra"
`);
    const acme = obj(cat.providers.acme);
    expect(acme.baseUrl).toBe("https://api.acme.test");
    expect(acme.apiKeyEnv).toBe("ACME_KEY");
    const model = obj((acme.models as unknown[])[0]);
    expect(model.name).toBe("GPT X-tra");
  });

  test('the literal "null" parses to JavaScript null (not empty string)', () => {
    const cat = parseCatalogYAML(`providers:
  acme:
    api: openai
    baseUrl: x
    apiKeyEnv: K
    models:
      - id: gpt-x
        name: GPT X
        deprecated: null
`);
    const model = obj((obj(cat.providers.acme).models as unknown[])[0]);
    expect(model.deprecated).toBeNull();
  });

  test("trailing ` # comment` is stripped from scalar values", () => {
    const cat = parseCatalogYAML(`providers:
  acme:
    api: openai # the api kind
    baseUrl: https://api.acme.test
    apiKeyEnv: KEY
    models:
      - id: gpt-x
        name: GPT X
`);
    expect(obj(cat.providers.acme).api).toBe("openai");
  });

  test("a `#` not preceded by whitespace is kept (URL fragment / no-space)", () => {
    const cat = parseCatalogYAML(`providers:
  acme:
    api: openai
    baseUrl: https://api.acme.test/#anchor
    apiKeyEnv: KEY
    models:
      - id: gpt-x
        name: GPT X
`);
    expect(obj(cat.providers.acme).baseUrl).toBe("https://api.acme.test/#anchor");
  });

  test("a `#` inside quotes is not treated as a comment", () => {
    const cat = parseCatalogYAML(`providers:
  acme:
    api: openai
    baseUrl: x
    apiKeyEnv: "K # not a comment"
    models:
      - id: gpt-x
        name: GPT X
`);
    expect(obj(cat.providers.acme).apiKeyEnv).toBe("K # not a comment");
  });

  test("missing top-level `providers` key throws a clear error", () => {
    expect(() => parseCatalogYAML(`foo: bar\nbaz: qux\n`)).toThrow(
      "models.yml: missing 'providers' key",
    );
  });

  test("empty `providers:` map is structurally valid (key present, not missing)", () => {
    const cat = parseCatalogYAML(`providers:\n`);
    expect(cat.providers).toEqual({});
  });
});

describe("the built-in DeepSeek catalog matches the provider's own list", () => {
  // DeepSeek's GET /v1/models answers exactly ["deepseek-flash",
  // "deepseek-v4-pro"]. The catalog previously offered `deepseek-v4-flash`,
  // which the provider has never served — picking it in the UI produced a
  // run that failed at dispatch with "model not available", looking exactly
  // like the bot ignoring the message.
  const deepseek = provider("deepseek");
  const ids = deepseek.models.map((m) => m.id);

  test("offers only ids the provider actually serves", () => {
    expect(ids).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
  });

  test("every alias pointing at a DeepSeek model lands on one of them", () => {
    // A dangling alias target is the same trap in a different shape: the id
    // resolves, matches nothing, and the run dies later.
    const deepseekTargets = Object.values(MODEL_ALIASES).filter((t) => t.startsWith("deepseek"));
    expect(deepseekTargets.length).toBeGreaterThan(0);
    for (const target of deepseekTargets) {
      expect(ids).toContain(target);
    }
  });

  test("legacy ids still resolve — including the one we published by mistake", () => {
    expect(resolveModelAlias("deepseek-chat")).toBe("deepseek-flash");
    // Configs written while the wrong id was in the catalog must not break.
    expect(resolveModelAlias("deepseek-v4-flash")).toBe("deepseek-flash");
    expect(resolveModelAlias("deepseek/deepseek-v4-flash")).toBe("deepseek/deepseek-flash");
  });
});

describe("the Z.AI provider is the GLM Coding Plan, not the PAYG API", () => {
  const zai = provider("zai");

  test("rides the coding-plan base URL", () => {
    // The general PAYG base (`/api/paas/v4`) is a different product: the
    // plan's credentials are validated against the coding path, and using
    // the PAYG one either bypasses plan quota or fails auth. oh-my-pi
    // carries the same warning next to its zai descriptor.
    expect(zai.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
    expect(zai.baseUrl).not.toContain("/api/paas/v4");
    expect(zai.apiKeyEnv).toBe("ZAI_API_KEY");
    expect(zai.api).toBe("openai-completions");
  });

  test("offers the ids the provider's own endpoint reports", () => {
    // Captured from GET https://api.z.ai/api/paas/v4/models (the catalog
    // list is the same set; it is the *base URL* that differs by product).
    expect(zai.models.map((m) => m.id).sort()).toEqual(
      [
        "glm-4.5",
        "glm-4.5-air",
        "glm-4.6",
        "glm-4.7",
        "glm-5",
        "glm-5-turbo",
        "glm-5.1",
        "glm-5.2",
        "glm-5.3",
        "glm-5.3-flash",
        "glm-5.3-flashx",
      ].sort(),
    );
  });

  test("every model carries priced metadata — none of it invented", () => {
    // Values come from models.dev (which the reference implementation also
    // uses); an entry with zero cost would silently distort the cost table.
    for (const m of zai.models) {
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxTokens).toBeGreaterThan(0);
      expect(m.cost?.input).toBeGreaterThan(0);
      expect(m.cost?.output).toBeGreaterThan(0);
      expect(m.reasoning).toBe(true);
    }
  });

  test("thinking is declared as the binary toggle the wire actually sends", () => {
    // compat "zai" emits `thinking: {type: enabled|disabled}`; extra levels
    // would be cosmetic, so only off/high are offered.
    for (const m of zai.models) {
      expect(m.thinking?.efforts).toEqual(["off", "high"]);
      expect(m.compat).toMatchObject({ thinkingFormat: "zai" });
    }
  });
});
