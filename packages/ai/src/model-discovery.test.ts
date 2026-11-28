import { describe, expect, test } from "bun:test";
import { buildModel, type CatalogSpec } from "./model-catalog.js";
import {
  describeDrift,
  diffServedModels,
  fetchProviderModels,
  mergeDiscoveredModelSpecs,
  parseServedModelIds,
  parseServedModels,
  syncCatalogFromProviders,
} from "./model-discovery.js";
import { createModelRuntime } from "./model-runtime.js";
import { createProvider } from "./providers/create-provider.js";

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

describe("parseServedModels + live catalog auto-sync", () => {
  test("parses DeepSeek, Anthropic, OpenRouter metadata and skips non-chat utility models", () => {
    const ds = parseServedModels(DEEPSEEK_RESPONSE);
    expect(ds[0]).toMatchObject({
      id: "deepseek-flash",
      name: "DeepSeek-V4.1-Flash",
      contextWindow: 1048576,
      maxTokens: 393216,
      input: ["text", "image"],
      reasoning: true,
    });
    expect(ds[0]?.thinking?.effortMap).toEqual({ xhigh: "max" });

    const anthropic = parseServedModels({
      data: [
        {
          id: "claude-sonnet-6",
          display_name: "Claude Sonnet 6",
          max_input_tokens: 1_000_000,
          max_tokens: 128_000,
          capabilities: {
            thinking: { supported: true },
            image_input: { supported: true },
          },
        },
      ],
    });
    expect(anthropic).toEqual([
      {
        id: "claude-sonnet-6",
        name: "Claude Sonnet 6",
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        input: ["text", "image"],
        reasoning: true,
      },
    ]);

    const openrouter = parseServedModels({
      data: [
        {
          id: "acme/new-model",
          name: "Acme New",
          context_length: 256_000,
          top_provider: { max_completion_tokens: 32_000 },
          architecture: { input_modalities: ["text", "image", "audio"] },
          pricing: { prompt: "0.000002", completion: "0.00001" },
        },
        { id: "whisper-1" },
        { id: "text-embedding-3-large" },
        { id: "inactive-model", active: false },
      ],
    });
    expect(openrouter).toHaveLength(1);
    expect(openrouter[0]).toMatchObject({
      id: "acme/new-model",
      contextWindow: 256_000,
      maxTokens: 32_000,
      input: ["text", "image"],
      cost: { input: 2, output: 10 },
    });
  });

  test("mergeDiscoveredModelSpecs preserves curated cost/compat, refreshes limits, and synthesizes new models", () => {
    const merged = mergeDiscoveredModelSpecs(
      {
        api: "openai-completions",
        models: [
          {
            id: "deepseek-flash",
            name: "DeepSeek Flash",
            contextWindow: 128_000,
            maxTokens: 8_192,
            cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
            compat: { thinkingFormat: "deepseek", maxTokensField: "max_tokens" },
          },
          { id: "retired-model", name: "Retired" },
        ],
      },
      [
        { id: "deepseek-flash", contextWindow: 1_048_576, maxTokens: 393_216 },
        { id: "deepseek-v5", name: "DeepSeek V5", contextWindow: 2_000_000, reasoning: true },
      ],
    );

    expect(merged.drift).toEqual({
      confirmed: ["deepseek-flash"],
      unserved: ["retired-model"],
      undeclared: ["deepseek-v5"],
    });
    const flash = merged.models.find((m) => m.id === "deepseek-flash")!;
    expect(flash.contextWindow).toBe(1_048_576);
    expect(flash.cost?.input).toBe(0.14); // curated pricing kept
    const v5 = merged.models.find((m) => m.id === "deepseek-v5")!;
    expect(v5.name).toBe("DeepSeek V5");
    expect(v5.compat).toEqual({ thinkingFormat: "deepseek", maxTokensField: "max_tokens" });
    expect(merged.models.some((m) => m.id === "retired-model")).toBe(true);
  });

  test("syncCatalogFromProviders updates reachable providers and isolates failures", async () => {
    const base: CatalogSpec = {
      providers: {
        anthropic: {
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com/v1",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          models: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
        },
        deepseek: {
          api: "openai-completions",
          baseUrl: "https://api.deepseek.com/v1",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          models: [{ id: "deepseek-flash", name: "DeepSeek Flash" }],
        },
      },
    };

    const res = await syncCatalogFromProviders(base, {
      resolveAuth: (pid) => ({ apiKey: `key-${pid}` }),
      fetchImpl: async (url) => {
        if (url.includes("anthropic")) {
          return Response.json({
            data: [
              { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
              {
                id: "claude-sonnet-6",
                display_name: "Claude Sonnet 6",
                max_input_tokens: 1_000_000,
              },
            ],
          });
        }
        throw new Error("network down");
      },
    });

    expect(res.updatedProviders).toEqual(["anthropic"]);
    expect(res.failedProviders).toEqual(["deepseek"]);
    expect(res.catalog.providers.anthropic!.models.map((m) => m.id)).toEqual([
      "claude-sonnet-5",
      "claude-sonnet-6",
    ]);
    // Failed provider keeps its static declaration intact
    expect(res.catalog.providers.deepseek!.models.map((m) => m.id)).toEqual(["deepseek-flash"]);
  });

  test("ModelRuntime.refreshCatalog({ sync: true }) live-updates provider models and marks unserved unavailable", async () => {
    const rt = createModelRuntime();
    rt.registerProvider(
      createProvider({
        id: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        auth: { apiKey: "k" },
        models: [
          buildModel("deepseek", "openai-completions", "https://api.deepseek.com/v1", {
            id: "deepseek-old",
            name: "Old",
            compat: { thinkingFormat: "deepseek", maxTokensField: "max_tokens" },
          }),
        ],
      }),
    );

    const cat = await rt.refreshCatalog({
      sync: true,
      fetchImpl: async () =>
        Response.json({
          data: [{ id: "deepseek-v5", name: "DeepSeek V5", context_window: 1_048_576 }],
        }),
    });

    const oldEntry = cat.models.find((m) => m.modelId === "deepseek-old");
    const newEntry = cat.models.find((m) => m.modelId === "deepseek-v5");
    expect(oldEntry?.available).toBe(false);
    expect(newEntry?.available).toBe(true);
    expect(newEntry?.contextWindow).toBe(1_048_576);
    expect(
      rt
        .getProvider("deepseek")
        ?.getModels()
        .some((m) => m.id === "deepseek-v5"),
    ).toBe(true);
  });

  test("fetchProviderModels sends anthropic headers for anthropic-messages", async () => {
    let seenHeaders: Record<string, string> = {};
    const res = await fetchProviderModels(
      { api: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1/" },
      { apiKey: "ant-key" },
      {
        fetchImpl: async (url, init) => {
          expect(url).toBe("https://api.anthropic.com/v1/models");
          seenHeaders = (init?.headers ?? {}) as Record<string, string>;
          return Response.json({ data: [{ id: "claude-sonnet-5" }] });
        },
      },
    );
    expect(res?.map((m) => m.id)).toEqual(["claude-sonnet-5"]);
    expect(seenHeaders["x-api-key"]).toBe("ant-key");
    expect(seenHeaders["anthropic-version"]).toBe("2023-06-01");
  });
});
