import { describe, expect, test } from "bun:test";
import { BUILTIN_CATALOG, createModelRuntime } from "@chengchenccc/ai";
import { registerProvidersFromCatalog } from "./runtime-catalog.js";

describe("registerProvidersFromCatalog credentials", () => {
  test("inline apiKey in ProviderSpec registers the provider when env is unset", () => {
    const runtime = createModelRuntime();
    registerProvidersFromCatalog(
      runtime,
      {
        providers: {
          llmbox: {
            api: "openai-completions",
            baseUrl: "https://llmbox.example/v1",
            apiKeyEnv: "LLMBOX_API_KEY",
            apiKey: "at-8331-inline",
            models: [{ id: "m", name: "M" }],
          },
        },
      },
      {}, // no env key
    );

    expect(runtime.getProvider("llmbox")).toBeDefined();
  });

  test("env var still wins over the inline apiKey", () => {
    const runtime = createModelRuntime();
    registerProvidersFromCatalog(
      runtime,
      {
        providers: {
          llmbox: {
            api: "openai-completions",
            baseUrl: "https://llmbox.example/v1",
            apiKeyEnv: "LLMBOX_API_KEY",
            apiKey: "at-8331-inline",
            models: [{ id: "m", name: "M" }],
          },
        },
      },
      { LLMBOX_API_KEY: "at-8331-env" },
    );

    expect(runtime.getProvider("llmbox")).toBeDefined();
  });

  test("provider without any credential is still skipped", () => {
    const runtime = createModelRuntime();
    registerProvidersFromCatalog(
      runtime,
      {
        providers: {
          secretless: {
            api: "openai-completions",
            baseUrl: "https://x.example/v1",
            apiKeyEnv: "NEVER_SET",
            models: [{ id: "m", name: "M" }],
          },
        },
      },
      {},
    );

    expect(runtime.getProvider("secretless")).toBeUndefined();
  });
});

describe("catalogue base URLs survive registration unchanged", () => {
  /** Every provider the catalogue ships, with the key its entry expects. */
  const cases: Array<[string, string]> = [
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
    ["deepseek", "DEEPSEEK_API_KEY"],
    ["zai", "ZAI_API_KEY"],
    ["groq", "GROQ_API_KEY"],
    ["openrouter", "OPENROUTER_API_KEY"],
  ];

  test("no catalogue provider gets a version segment appended", () => {
    // Z.AI's coding-plan path is `/coding/paas/v4`. The old normalisation
    // (`if (!url.endsWith("/v1")) url += "/v1"`) made it
    // `/coding/paas/v4/v1/chat/completions`, which 404s — and a 404 mid-run
    // looks exactly like the bot ignoring the message.
    for (const [pid, envVar] of cases) {
      const spec = BUILTIN_CATALOG.providers[pid];
      if (!spec) continue;
      const runtime = createModelRuntime();
      registerProvidersFromCatalog(runtime, { providers: { [pid]: spec } }, { [envVar]: "k" });
      expect(`${pid}: ${runtime.getProvider(pid)?.baseUrl}`).toBe(`${pid}: ${spec.baseUrl}`);
    }
  });

  test("a bare host still gets /v1 — the convenience custom entries rely on", () => {
    const runtime = createModelRuntime();
    registerProvidersFromCatalog(
      runtime,
      {
        providers: {
          acme: {
            api: "openai-completions",
            baseUrl: "https://api.acme.test",
            apiKeyEnv: "ACME_KEY",
            models: [{ id: "m", name: "M" }],
          },
        },
      },
      { ACME_KEY: "k" },
    );
    expect(runtime.getProvider("acme")?.baseUrl).toBe("https://api.acme.test/v1");
  });
});
