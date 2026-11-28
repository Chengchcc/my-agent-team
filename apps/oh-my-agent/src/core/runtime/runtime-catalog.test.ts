import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_CATALOG, createModelRuntime } from "@chengchenccc/ai";
import {
  isCatalogCacheStale,
  loadRuntimeCatalog,
  readCachedCatalog,
  registerProvidersFromCatalog,
  syncRuntimeCatalog,
} from "./runtime-catalog.js";

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

  test("a bare host is passed through as-is, and warns instead of guessing", () => {
    // Alignment with the reference implementation: it composes
    // `${baseUrl}/chat/completions` and never invents a version segment.
    // The old auto-append made `https://api.acme.test` work by accident and
    // silently rewrote any other unusual path — so the guess is gone and a
    // warning says what to fix instead.
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
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
      expect(runtime.getProvider("acme")?.baseUrl).toBe("https://api.acme.test");
    } finally {
      console.warn = original;
    }
    expect(warnings.some((w) => w.includes("acme") && w.includes("no version segment"))).toBe(true);
  });

  test("a complete versioned path neither changes nor warns", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      const runtime = createModelRuntime();
      registerProvidersFromCatalog(
        runtime,
        { providers: { zai: BUILTIN_CATALOG.providers.zai! } },
        { ZAI_API_KEY: "k" },
      );
      expect(runtime.getProvider("zai")?.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
    } finally {
      console.warn = original;
    }
    expect(warnings).toEqual([]);
  });
});

describe("provider catalog auto-sync and cache precedence", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function freshHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "oma-cat-sync-"));
    tmpDirs.push(dir);
    return dir;
  }

  test("syncRuntimeCatalog persists discovered models to models-cache.json and loadRuntimeCatalog picks them up", async () => {
    const omaHome = freshHome();
    const env = {
      OMA_HOME: omaHome,
      OMA_WORKSPACE_CATALOG: "0",
      DEEPSEEK_API_KEY: "ds-key",
    };

    expect(isCatalogCacheStale(env)).toBe(true);
    const res = await syncRuntimeCatalog(env, {
      fetchImpl: async () =>
        Response.json({
          data: [
            { id: "deepseek-flash", context_window: 2_000_000 },
            { id: "deepseek-v5", name: "DeepSeek V5", context_window: 2_000_000 },
          ],
        }),
    });

    expect(res?.updatedProviders).toEqual(["deepseek"]);
    expect(
      readCachedCatalog(env)?.providers.deepseek?.models.some((m) => m.id === "deepseek-v5"),
    ).toBe(true);
    expect(isCatalogCacheStale(env)).toBe(false);

    const loaded = loadRuntimeCatalog(env);
    const dsModels = loaded.providers.deepseek!.models;
    expect(dsModels.some((m) => m.id === "deepseek-v5")).toBe(true);
    expect(dsModels.find((m) => m.id === "deepseek-flash")?.contextWindow).toBe(2_000_000);
  });

  test("models.yml user overrides still win over models-cache.json", async () => {
    const omaHome = freshHome();
    writeFileSync(
      join(omaHome, "models.yml"),
      `providers:\n  deepseek:\n    api: openai-completions\n    baseUrl: https://api.deepseek.com/v1\n    apiKeyEnv: DEEPSEEK_API_KEY\n    models:\n      - id: deepseek-flash\n        name: My Custom Flash\n        contextWindow: 64000\n`,
      "utf-8",
    );
    const env = {
      OMA_HOME: omaHome,
      OMA_WORKSPACE_CATALOG: "0",
      DEEPSEEK_API_KEY: "ds-key",
    };

    await syncRuntimeCatalog(env, {
      fetchImpl: async () =>
        Response.json({
          data: [
            { id: "deepseek-flash", context_window: 1_048_576 },
            { id: "deepseek-v5", name: "DeepSeek V5" },
          ],
        }),
    });

    const loaded = loadRuntimeCatalog(env);
    const flash = loaded.providers.deepseek!.models.find((m) => m.id === "deepseek-flash");
    expect(flash?.name).toBe("My Custom Flash");
    expect(flash?.contextWindow).toBe(64_000);
    expect(loaded.providers.deepseek!.models.some((m) => m.id === "deepseek-v5")).toBe(true);
  });

  test("reads provider tokens and baseUrl from SQLite when env vars are unset", async () => {
    const { Database } = await import("bun:sqlite");
    const omaHome = freshHome();
    const dbPath = join(omaHome, "backend.db");
    const db = new Database(dbPath);
    db.exec(
      "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
    db.query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
      "provider.deepseek",
      JSON.stringify({ apiKey: "sk-ds-sqlite-key", baseUrl: "https://ds-proxy.test/v1" }),
      Date.now(),
    );
    db.query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
      "providerEnv",
      JSON.stringify({ GROQ_API_KEY: "gsk-sqlite-custom" }),
      Date.now(),
    );
    db.close();

    const env = { OMA_HOME: omaHome, OMA_CREDENTIALS_DB: dbPath };
    const runtime = createModelRuntime();
    registerProvidersFromCatalog(runtime, BUILTIN_CATALOG, env);
    expect(runtime.getProvider("deepseek")?.baseUrl).toBe("https://ds-proxy.test/v1");
    expect(runtime.getProvider("groq")).toBeDefined();

    const seenUrls: string[] = [];
    const seenAuths: string[] = [];
    const syncRes = await syncRuntimeCatalog(env, {
      fetchImpl: async (url, init) => {
        seenUrls.push(url);
        seenAuths.push(String((init?.headers as Record<string, string>)?.Authorization ?? ""));
        return Response.json({ data: [{ id: "deepseek-v5" }] });
      },
    });
    expect(syncRes?.updatedProviders).toContain("deepseek");
    expect(seenUrls).toContain("https://ds-proxy.test/v1/models");
    expect(seenAuths).toContain("Bearer sk-ds-sqlite-key");
  });
});
