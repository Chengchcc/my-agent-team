import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  BUILTIN_CATALOG,
  buildAllModels,
  type CatalogSpec,
  type CatalogSyncResult,
  createProvider,
  type FetchLike,
  type ModelRuntime,
  type ModelSpec,
  type ProviderSpec,
  parseCatalogYAML,
  readSqliteProviderCredentials,
  type SqliteProviderCredentialsSnapshot,
  syncCatalogFromProviders,
} from "@chengchenccc/ai";

export const DEFAULT_CATALOG_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface CachedCatalogFile {
  readonly updatedAt: number;
  readonly providers: Record<string, { models: ModelSpec[] }>;
  readonly unservedByProvider?: Record<string, string[]>;
}

/** Candidate file paths for runtime model config, in priority order. */
function catalogPaths(env: Record<string, string | undefined>): string[] {
  // H6: under OMA_WORKSPACE_CATALOG=0 (set by the product backend for its
  // children) the catalog comes ONLY from the deployment-pinned OMA_HOME.
  if (env.OMA_WORKSPACE_CATALOG === "0") {
    return env.OMA_HOME ? [join(env.OMA_HOME, "models.yml")] : [];
  }
  const paths: string[] = [];
  if (env.OMA_HOME) paths.push(join(env.OMA_HOME, "models.yml"));
  paths.push(join(env.HOME ?? homedir(), ".oma", "models.yml"));
  paths.push(resolve(".oma", "models.yml"));
  return paths;
}

/** Path for auto-synced provider model cache (`models-cache.json`).
 *  Respects H6 isolation: under OMA_WORKSPACE_CATALOG=0 uses ONLY OMA_HOME. */
export function catalogCachePath(env: Record<string, string | undefined>): string | null {
  if (env.OMA_WORKSPACE_CATALOG === "0") {
    return env.OMA_HOME ? join(env.OMA_HOME, "models-cache.json") : null;
  }
  const baseDir = env.OMA_HOME ?? join(env.HOME ?? homedir(), ".oma");
  return join(baseDir, "models-cache.json");
}

/** Read the auto-synced provider model cache if present and valid. */
export function readCachedCatalog(
  env: Record<string, string | undefined> = process.env,
): CachedCatalogFile | null {
  const path = catalogCachePath(env);
  if (!path || !existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<CachedCatalogFile>;
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof raw.updatedAt !== "number" ||
      typeof raw.providers !== "object" ||
      raw.providers === null
    ) {
      return null;
    }
    return {
      updatedAt: raw.updatedAt,
      providers: raw.providers,
      ...(raw.unservedByProvider ? { unservedByProvider: raw.unservedByProvider } : {}),
    };
  } catch {
    return null;
  }
}

/** Atomically persist auto-synced provider models to `models-cache.json`. */
export function writeCachedCatalog(
  snapshot: CachedCatalogFile,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const path = catalogCachePath(env);
  if (!path) return null;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
  return path;
}

/** True when no cache exists yet or the cache is older than `ttlMs`. */
export function isCatalogCacheStale(
  env: Record<string, string | undefined> = process.env,
  ttlMs = DEFAULT_CATALOG_CACHE_TTL_MS,
  now = Date.now(),
): boolean {
  const cached = readCachedCatalog(env);
  if (!cached) return true;
  return now - cached.updatedAt >= ttlMs;
}

function loadUserYamlCatalog(env: Record<string, string | undefined>): CatalogSpec | null {
  for (const p of catalogPaths(env)) {
    if (!existsSync(p)) continue;
    return parseCatalogYAML(readFileSync(p, "utf-8"));
  }
  return null;
}

/** Merge ONLY discovered model lists from cache into an existing catalog.
 *  Cache can never overwrite `baseUrl`, `apiKey`, `apiKeyEnv`, or `headers`. */
function mergeCachedModels(base: CatalogSpec, cache: CachedCatalogFile): CatalogSpec {
  const providers: Record<string, ProviderSpec> = { ...base.providers };
  for (const [pid, cachedEntry] of Object.entries(cache.providers)) {
    const bSpec = providers[pid];
    if (!bSpec || !Array.isArray(cachedEntry?.models)) continue;
    providers[pid] = {
      ...bSpec,
      models: mergeModelLists(bSpec.models, cachedEntry.models),
    };
  }
  return { providers };
}

/** Read and merge BUILTIN_CATALOG ← auto-synced models-cache.json ← user models.yml.
 *  User overrides in models.yml always win over cached/discovered metadata. */
export function loadRuntimeCatalog(
  env: Record<string, string | undefined> = process.env,
): CatalogSpec {
  const userYaml = loadUserYamlCatalog(env);
  const declared = userYaml ? mergeCatalogs(BUILTIN_CATALOG, userYaml) : BUILTIN_CATALOG;
  const cached = readCachedCatalog(env);
  if (!cached) return declared;
  const withCache = mergeCachedModels(declared, cached);
  // Re-apply user YAML on top so explicit manual model edits always win over cache.
  return userYaml ? mergeCatalogs(withCache, userYaml) : withCache;
}

/** Probe every authenticated provider's `/models` endpoint, merge newly
 *  discovered models + refreshed metadata, and atomically write `models-cache.json`. */
export async function syncRuntimeCatalog(
  env: Record<string, string | undefined> = process.env,
  opts?: {
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    pruneUnserved?: boolean;
    force?: boolean;
  },
): Promise<CatalogSyncResult | null> {
  if (env.OMA_FAKE_PROVIDER === "1") return null;
  if (!opts?.force && env.OMA_CATALOG_AUTO_SYNC === "0") return null;

  const userYaml = loadUserYamlCatalog(env);
  const declared = userYaml ? mergeCatalogs(BUILTIN_CATALOG, userYaml) : BUILTIN_CATALOG;
  const sqliteCreds = loadSqliteCredentials(env);

  const result = await syncCatalogFromProviders(declared, {
    resolveAuth: (pid, spec) => {
      const apiKey = resolveApiKey(pid, spec.apiKeyEnv, spec.apiKey, env, sqliteCreds);
      const headers = mergeHeaders(spec.headers, sqliteCreds.providers[pid]?.headers);
      if (!apiKey && !headers) return null;
      return {
        ...(apiKey ? { apiKey } : {}),
        baseUrl: resolveBaseUrl(pid, spec.baseUrl, env, sqliteCreds),
        ...(headers ? { headers } : {}),
      };
    },
    fetchImpl: opts?.fetchImpl,
    timeoutMs: opts?.timeoutMs,
    pruneUnserved: opts?.pruneUnserved,
  });

  if (result.updatedProviders.length > 0) {
    const providersCache: Record<string, { models: ModelSpec[] }> = {};
    for (const pid of result.updatedProviders) {
      const spec = result.catalog.providers[pid];
      if (spec) providersCache[pid] = { models: spec.models };
    }
    try {
      writeCachedCatalog(
        {
          updatedAt: Date.now(),
          providers: providersCache,
          unservedByProvider: result.unservedByProvider,
        },
        env,
      );
    } catch {
      /* cache write is best-effort (e.g. read-only home dir) */
    }
  }

  return result;
}

/** Fire-and-forget stale-while-revalidate sync: 0ms startup latency when fresh,
 *  silently refreshes `models-cache.json` in the background when stale. */
export function maybeBackgroundSyncCatalog(
  env: Record<string, string | undefined> = process.env,
  ttlMs = DEFAULT_CATALOG_CACHE_TTL_MS,
): void {
  if (env.OMA_FAKE_PROVIDER === "1" || env.OMA_CATALOG_AUTO_SYNC === "0") return;
  if (!isCatalogCacheStale(env, ttlMs)) return;
  void syncRuntimeCatalog(env).catch(() => {
    /* background sync never interrupts a CLI session */
  });
}

/** Deep-merge two catalogs: override providers/models win; new entries added.
 *  Provider-level fields (api, baseUrl, apiKeyEnv) are overridden when present.
 *  Within a provider, models merge by id. */
function mergeCatalogs(base: CatalogSpec, override: CatalogSpec): CatalogSpec {
  const providers: Record<string, ProviderSpec> = { ...base.providers };
  for (const [pid, oSpec] of Object.entries(override.providers)) {
    const bSpec = providers[pid];
    providers[pid] = bSpec
      ? { ...bSpec, ...oSpec, models: mergeModelLists(bSpec.models, oSpec.models) }
      : oSpec;
  }
  return { providers };
}

function mergeModelLists(base: ModelSpec[], override: ModelSpec[]): ModelSpec[] {
  const byId = new Map<string, ModelSpec>();
  for (const m of base) byId.set(m.id, m);
  for (const m of override) byId.set(m.id, m);
  return [...byId.values()];
}

/** Register every provider in the catalog whose apiKey is available from
 *  SQLite (`OMA_CREDENTIALS_DB` / `BACKEND_DATA_DIR/backend.db` / `$OMA_HOME/credentials.db`),
 *  environment variables, or `models.yml`. Providers without credentials are skipped. */
export function registerProvidersFromCatalog(
  runtime: ModelRuntime,
  catalog: CatalogSpec,
  env: Record<string, string | undefined>,
): void {
  const built = buildAllModels(catalog);
  const sqliteCreds = loadSqliteCredentials(env);
  for (const [pid, entry] of Object.entries(built)) {
    const apiKey = resolveApiKey(pid, entry.spec.apiKeyEnv, entry.spec.apiKey, env, sqliteCreds);
    if (!apiKey) continue;
    const baseUrl = resolveBaseUrl(pid, entry.spec.baseUrl, env, sqliteCreds);
    const headers = mergeHeaders(entry.spec.headers, sqliteCreds.providers[pid]?.headers);
    runtime.registerProvider(
      createProvider({
        id: pid,
        name: pid,
        baseUrl,
        api: entry.spec.api,
        auth: { apiKey, ...(headers ? { headers } : {}) },
        models: entry.models,
      }),
    );
  }
}

const EMPTY_SQLITE_CREDS: SqliteProviderCredentialsSnapshot = { providers: {}, env: {} };

/** Resolve SQLite credentials DB path while honoring H6 isolation:
 *  under `OMA_WORKSPACE_CATALOG=0` only an explicitly provided `OMA_CREDENTIALS_DB`
 *  is read (never ambient workspace or home DB files). */
export function credentialsDbPath(env: Record<string, string | undefined>): string | null {
  if (env.OMA_CREDENTIALS_DB?.trim()) return env.OMA_CREDENTIALS_DB.trim();
  if (env.OMA_WORKSPACE_CATALOG === "0") return null;
  if (env.BACKEND_DATA_DIR?.trim()) {
    const backendDb = join(env.BACKEND_DATA_DIR.trim(), "backend.db");
    if (existsSync(backendDb)) return backendDb;
  }
  const baseDir = env.OMA_HOME ?? join(env.HOME ?? homedir(), ".oma");
  const omaDb = join(baseDir, "credentials.db");
  if (existsSync(omaDb)) return omaDb;
  return null;
}

function loadSqliteCredentials(
  env: Record<string, string | undefined>,
): SqliteProviderCredentialsSnapshot {
  const dbPath = credentialsDbPath(env);
  if (!dbPath) return EMPTY_SQLITE_CREDS;
  return readSqliteProviderCredentials(dbPath);
}

function mergeHeaders(
  specHeaders: Record<string, string> | undefined,
  dbHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!specHeaders && !dbHeaders) return undefined;
  return { ...(specHeaders ?? {}), ...(dbHeaders ?? {}) };
}

/** Resolve API key: SQLite (`providerEnv` / `provider.<id>`) first, then env
 *  var, then the provider's inline apiKey from models.yml, then provider-specific
 *  fallbacks (ANTHROPIC_AUTH_TOKEN as a fallback for ANTHROPIC_API_KEY). */
function resolveApiKey(
  pid: string,
  primaryEnv: string,
  inlineApiKey: string | undefined,
  env: Record<string, string | undefined>,
  sqliteCreds: SqliteProviderCredentialsSnapshot = EMPTY_SQLITE_CREDS,
): string | undefined {
  const dbCustom = primaryEnv ? sqliteCreds.env[primaryEnv]?.trim() : undefined;
  if (dbCustom) return dbCustom;
  const dbKey = sqliteCreds.providers[pid]?.apiKey?.trim();
  if (dbKey) return dbKey;
  const key = env[primaryEnv];
  if (key) return key;
  if (inlineApiKey) return inlineApiKey;
  if (pid === "anthropic") return env.ANTHROPIC_AUTH_TOKEN;
  return undefined;
}

function resolveBaseUrl(
  pid: string,
  specBaseUrl: string,
  env: Record<string, string | undefined>,
  sqliteCreds: SqliteProviderCredentialsSnapshot = EMPTY_SQLITE_CREDS,
): string {
  const dbBaseUrl = sqliteCreds.providers[pid]?.baseUrl?.trim();
  if (dbBaseUrl) return dbBaseUrl.replace(/\/+$/, "");
  const envBaseUrl =
    env[`${pid.toUpperCase()}_BASE_URL`]?.trim() ||
    (pid === "anthropic" ? env.ANTHROPIC_BASE_URL?.trim() : undefined);
  if (envBaseUrl) return envBaseUrl.replace(/\/+$/, "");
  const url = specBaseUrl.trim().replace(/\/+$/, "");
  const lastSegment = url.split("/").pop() ?? "";
  if (!/^v\d+$/.test(lastSegment)) {
    console.warn(
      `[oma] provider "${pid}" baseUrl has no version segment (${url}); ` +
        `requests will go to ${url}/chat/completions — there is no /v1 auto-append any more, ` +
        "so write the complete path in models.yml.",
    );
  }
  return url;
}
