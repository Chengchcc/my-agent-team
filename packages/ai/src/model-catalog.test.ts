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
  const deepseek = BUILTIN_CATALOG.providers.deepseek;
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
