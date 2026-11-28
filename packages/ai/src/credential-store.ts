import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { BUILTIN_CATALOG, type CatalogSpec } from "./model-catalog.js";
import type { CredentialStore, ResolvedCredential } from "./types.js";

const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SqliteProviderCredentialsSnapshot {
  /** Provider rows stored under `provider.<id>` in the settings KV table. */
  readonly providers: Readonly<Record<string, ResolvedCredential>>;
  /** Custom env-key map stored under `providerEnv` (e.g. `ZAI_API_KEY`). */
  readonly env: Readonly<Record<string, string>>;
}

export interface SqliteCredentialStoreOptions {
  /** Fallback (or primary, when `priority: "env-first"`) environment map.
   *  Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Catalog used to look up `apiKeyEnv` for each provider id.
   *  Defaults to `BUILTIN_CATALOG`. */
  readonly catalog?: CatalogSpec;
  /** SQLite KV table name (columns: `key`, `value`). Defaults to `"settings"`. */
  readonly table?: string;
  /** Resolution order between SQLite and environment variables.
   *  - `"sqlite-first"` (default): explicit DB settings win over ambient env.
   *  - `"env-first"`: ambient env wins over DB settings. */
  readonly priority?: "sqlite-first" | "env-first";
}

function normalizeStringRecord(v: unknown): Record<string, string> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string" && val.length > 0) out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Read provider credentials from a SQLite settings KV table (`key`, `value`).
 *  Accepts an open `Database` handle or a file path (opened readonly and closed
 *  before returning). Fails open to an empty snapshot when the file or table
 *  does not exist yet. */
export function readSqliteProviderCredentials(
  source: Database | string,
  opts?: { readonly table?: string },
): SqliteProviderCredentialsSnapshot {
  const table = opts?.table ?? "settings";
  if (!SAFE_IDENT_RE.test(table)) {
    throw new Error(`Invalid SQLite table name: "${table}"`);
  }

  let db: Database | null = null;
  let owned = false;
  try {
    if (typeof source === "string") {
      if (!source.trim() || !existsSync(source)) return { providers: {}, env: {} };
      db = new Database(source, { readonly: true });
      owned = true;
    } else {
      db = source;
    }

    const rows = db
      .query(`SELECT key, value FROM ${table} WHERE key LIKE 'provider.%' OR key = 'providerEnv'`)
      .all() as Array<{ key?: unknown; value?: unknown }>;

    const providers: Record<string, ResolvedCredential> = {};
    const env: Record<string, string> = {};

    for (const row of rows) {
      if (typeof row.key !== "string" || typeof row.value !== "string") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        continue;
      }
      if (row.key === "providerEnv") {
        const map = normalizeStringRecord(parsed);
        if (map) Object.assign(env, map);
        continue;
      }
      if (row.key.startsWith("provider.")) {
        const pid = row.key.slice("provider.".length).trim();
        if (!pid || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          continue;
        }
        const rec = parsed as Record<string, unknown>;
        const apiKey = typeof rec.apiKey === "string" ? rec.apiKey.trim() : "";
        const baseUrl = typeof rec.baseUrl === "string" ? rec.baseUrl.trim() : "";
        const headers = normalizeStringRecord(rec.headers);
        if (apiKey || baseUrl || headers) {
          providers[pid] = {
            ...(apiKey ? { apiKey } : {}),
            ...(baseUrl ? { baseUrl } : {}),
            ...(headers ? { headers } : {}),
          };
        }
      }
    }

    return { providers, env };
  } catch {
    return { providers: {}, env: {} };
  } finally {
    if (owned && db) {
      try {
        db.close();
      } catch {
        /* ignore close errors */
      }
    }
  }
}

function envBaseUrlFor(
  providerId: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const generic = env[`${providerId.toUpperCase()}_BASE_URL`]?.trim();
  if (generic) return generic;
  if (providerId === "anthropic") {
    const legacy = env.ANTHROPIC_BASE_URL?.trim();
    if (legacy) return legacy;
  }
  return undefined;
}

function envApiKeyFor(
  providerId: string,
  apiKeyEnv: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const primary = apiKeyEnv ? env[apiKeyEnv]?.trim() : undefined;
  if (primary) return primary;
  if (providerId === "anthropic") {
    const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim();
    if (authToken) return authToken;
  }
  return undefined;
}

/** Env-var-only CredentialStore backed by a CatalogSpec's `apiKeyEnv` names. */
export function createEnvCredentialStore(
  env: Readonly<Record<string, string | undefined>> = process.env,
  catalog: CatalogSpec = BUILTIN_CATALOG,
): CredentialStore {
  return {
    async resolve(providerId: string): Promise<ResolvedCredential | null> {
      const spec = catalog.providers[providerId];
      const apiKey = envApiKeyFor(providerId, spec?.apiKeyEnv, env);
      const baseUrl = envBaseUrlFor(providerId, env);
      if (!apiKey && !baseUrl) return null;
      return {
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseUrl } : {}),
      };
    },
  };
}

/** CredentialStore that reads provider tokens from SQLite (`settings` table:
 *  `provider.<id>` + `providerEnv`) AND environment variables. Live-reads on
 *  each call so tokens saved via Settings take effect without a restart. */
export function createSqliteCredentialStore(
  source: Database | string,
  opts?: SqliteCredentialStoreOptions,
): CredentialStore {
  const env = opts?.env ?? process.env;
  const catalog = opts?.catalog ?? BUILTIN_CATALOG;
  const table = opts?.table ?? "settings";
  const priority = opts?.priority ?? "sqlite-first";

  return {
    async resolve(providerId: string): Promise<ResolvedCredential | null> {
      const snap = readSqliteProviderCredentials(source, { table });
      const spec = catalog.providers[providerId];
      const dbCred = snap.providers[providerId];
      const dbCustomKey = spec?.apiKeyEnv ? snap.env[spec.apiKeyEnv]?.trim() : undefined;
      // Within SQLite: explicit custom env-key overrides provider.<id> (matches ProviderService).
      const dbApiKey = dbCustomKey || dbCred?.apiKey;
      const envApiKey = envApiKeyFor(providerId, spec?.apiKeyEnv, env);
      const envBaseUrl = envBaseUrlFor(providerId, env);

      const apiKey = priority === "env-first" ? envApiKey || dbApiKey : dbApiKey || envApiKey;
      const baseUrl =
        priority === "env-first" ? envBaseUrl || dbCred?.baseUrl : dbCred?.baseUrl || envBaseUrl;
      const headers = dbCred?.headers;

      if (!apiKey && !baseUrl && !headers) return null;
      return {
        ...(apiKey ? { apiKey } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(headers ? { headers } : {}),
      };
    },
  };
}
