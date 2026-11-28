import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEnvCredentialStore,
  createSqliteCredentialStore,
  readSqliteProviderCredentials,
} from "./credential-store.js";
import { createModelRuntime } from "./model-runtime.js";
import { createProvider } from "./providers/create-provider.js";

const tempDirs: string[] = [];

function makeDbFile(): { db: Database; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "ai-cred-store-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "backend.db");
  const db = new Database(dbPath);
  db.exec(
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  );
  return { db, dbPath };
}

function setSetting(db: Database, key: string, value: unknown): void {
  db.query("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
    key,
    JSON.stringify(value),
    Date.now(),
  );
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("SQLite + env CredentialStore", () => {
  test("readSqliteProviderCredentials reads provider.<id> and providerEnv from file path and fails open when missing", () => {
    expect(readSqliteProviderCredentials("/tmp/definitely-missing-ai-cred.db")).toEqual({
      providers: {},
      env: {},
    });

    const { db, dbPath } = makeDbFile();
    setSetting(db, "provider.deepseek", {
      apiKey: "sk-ds-sqlite",
      baseUrl: "https://proxy.deepseek.test/v1",
      headers: { "X-Tenant": "team-a" },
    });
    setSetting(db, "providerEnv", { ZAI_API_KEY: "sk-zai-custom" });
    setSetting(db, "unrelated.key", { foo: "bar" });
    db.close();

    const snap = readSqliteProviderCredentials(dbPath);
    expect(snap.providers.deepseek).toEqual({
      apiKey: "sk-ds-sqlite",
      baseUrl: "https://proxy.deepseek.test/v1",
      headers: { "X-Tenant": "team-a" },
    });
    expect(snap.env).toEqual({ ZAI_API_KEY: "sk-zai-custom" });
  });

  test("createSqliteCredentialStore resolves SQLite tokens first, falls back to env, and honors env-first priority", async () => {
    const { db } = makeDbFile();
    setSetting(db, "provider.openai", {
      apiKey: "sk-openai-db",
      baseUrl: "https://db-openai.test/v1",
    });
    setSetting(db, "providerEnv", { ZAI_API_KEY: "sk-zai-db-env" });

    const env = {
      OPENAI_API_KEY: "sk-openai-env",
      OPENAI_BASE_URL: "https://env-openai.test/v1",
      GROQ_API_KEY: "gsk-env-only",
    };

    const sqliteFirst = createSqliteCredentialStore(db, { env });
    expect(await sqliteFirst.resolve("openai")).toEqual({
      apiKey: "sk-openai-db",
      baseUrl: "https://db-openai.test/v1",
    });
    expect(await sqliteFirst.resolve("zai")).toEqual({ apiKey: "sk-zai-db-env" });
    expect(await sqliteFirst.resolve("groq")).toEqual({ apiKey: "gsk-env-only" });
    expect(await sqliteFirst.resolve("openrouter")).toBeNull();

    const envFirst = createSqliteCredentialStore(db, { env, priority: "env-first" });
    expect(await envFirst.resolve("openai")).toEqual({
      apiKey: "sk-openai-env",
      baseUrl: "https://env-openai.test/v1",
    });

    // Live updates written to SQLite take effect immediately without rebuilding the store.
    setSetting(db, "provider.openrouter", { apiKey: "sk-or-live" });
    expect(await sqliteFirst.resolve("openrouter")).toEqual({ apiKey: "sk-or-live" });
    db.close();
  });

  test("createEnvCredentialStore resolves apiKey and <PROVIDER>_BASE_URL from env", async () => {
    const store = createEnvCredentialStore({
      ANTHROPIC_AUTH_TOKEN: "sk-ant-fallback",
      ANTHROPIC_BASE_URL: "https://ant.proxy/v1",
    });
    expect(await store.resolve("anthropic")).toEqual({
      apiKey: "sk-ant-fallback",
      baseUrl: "https://ant.proxy/v1",
    });
    expect(await store.resolve("openai")).toBeNull();
  });

  test("ModelRuntime.refreshCatalog({ sync: true }) uses SQLite CredentialStore tokens", async () => {
    const { db } = makeDbFile();
    setSetting(db, "provider.deepseek", { apiKey: "sk-ds-from-sqlite" });

    const rt = createModelRuntime({
      credentialStore: createSqliteCredentialStore(db, { env: {} }),
    });
    rt.registerProvider(
      createProvider({
        id: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        auth: {},
        models: [
          {
            id: "deepseek-flash",
            name: "DeepSeek Flash",
            provider: "deepseek",
            api: "openai-completions",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 8_192,
          },
        ],
      }),
    );

    let seenAuth = "";
    const res = await rt.refreshCatalog({
      sync: true,
      fetchImpl: async (_url, init) => {
        seenAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
        return new Response(
          JSON.stringify({ data: [{ id: "deepseek-flash" }, { id: "deepseek-v5" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    db.close();

    expect(seenAuth).toBe("Bearer sk-ds-from-sqlite");
    expect(res.models.map((m) => m.modelId)).toContain("deepseek-v5");
  });
});
