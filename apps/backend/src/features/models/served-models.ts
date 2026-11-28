import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BUILTIN_CATALOG,
  createSqliteCredentialStore,
  type DiscoveredModel,
  type FetchLike,
  fetchProviderModels,
  type ModelSpec,
  mergeDiscoveredModelSpecs,
  type ProviderSpec,
} from "@chengchenccc/ai";

/** What a provider actually serves, as opposed to what our static catalog declares.
 *
 *  Upgraded for live catalog auto-sync:
 *  - `serves()` stays synchronous and never blocks (stale-while-revalidate).
 *  - `discovered()` exposes rich `DiscoveredModel[]` metadata (contextWindow,
 *    maxTokens, input modalities, reasoning, pricing, brand-new model IDs).
 *  - `syncNow()` performs an explicit awaitable refresh across providers.
 *  - Unknown (never probed, probe failed, no key) stays `null` — never wipes
 *    the picker or marks models unavailable. */

export type ServedModelProbe = (providerId: string) => Promise<readonly string[] | null>;
export type ProviderCatalogProbe = (
  providerId: string,
) => Promise<readonly DiscoveredModel[] | null>;

export type { FetchLike };

export interface ServedModelKnowledge {
  /** `true` = the provider lists it, `false` = the provider lists other ids,
   *  `null` = unknown: keep the declared answer. */
  serves(providerId: string, modelId: string): boolean | null;
  /** Rich discovered models from the latest successful probe, or null if unknown. */
  discovered(providerId: string): readonly DiscoveredModel[] | null;
  /** Ask for a non-blocking background refresh; never throws. */
  refresh(providerIds: readonly string[]): void;
  /** Explicitly probe the given providers (or all builtin providers) and await
   *  completion so `/api/models/refresh` returns live data immediately. */
  syncNow(
    providerIds?: readonly string[],
  ): Promise<{ updatedProviders: string[]; failedProviders: string[] }>;
}

export function createServedModelKnowledge(deps: {
  probe?: ServedModelProbe;
  probeModels?: ProviderCatalogProbe;
  onSynced?: (providerId: string, models: readonly DiscoveredModel[]) => void;
  ttlMs?: number;
  failureTtlMs?: number;
  now?: () => number;
}): ServedModelKnowledge {
  const ttlMs = deps.ttlMs ?? 10 * 60_000;
  const failureTtlMs = deps.failureTtlMs ?? 60_000;
  const now = deps.now ?? Date.now;
  const entries = new Map<
    string,
    {
      at: number;
      ids: readonly string[] | null;
      models: readonly DiscoveredModel[] | null;
      ttl: number;
    }
  >();
  const inFlight = new Map<string, Promise<boolean>>();

  const runProbe = (providerId: string): Promise<boolean> => {
    const existing = inFlight.get(providerId);
    if (existing) return existing;

    const promise = (async (): Promise<boolean> => {
      try {
        if (deps.probeModels) {
          const models = await deps.probeModels(providerId);
          if (models) {
            const ids = models.map((m) => m.id);
            entries.set(providerId, { at: now(), ids, models, ttl: ttlMs });
            try {
              deps.onSynced?.(providerId, models);
            } catch {
              /* sync hook is best-effort */
            }
            return true;
          }
          entries.set(providerId, { at: now(), ids: null, models: null, ttl: failureTtlMs });
          return false;
        }
        if (deps.probe) {
          const ids = await deps.probe(providerId);
          if (ids) {
            const models = ids.map((id) => ({ id }));
            entries.set(providerId, { at: now(), ids, models, ttl: ttlMs });
            try {
              deps.onSynced?.(providerId, models);
            } catch {
              /* sync hook is best-effort */
            }
            return true;
          }
          entries.set(providerId, { at: now(), ids: null, models: null, ttl: failureTtlMs });
          return false;
        }
        return false;
      } catch {
        entries.set(providerId, { at: now(), ids: null, models: null, ttl: failureTtlMs });
        return false;
      } finally {
        inFlight.delete(providerId);
      }
    })();

    inFlight.set(providerId, promise);
    return promise;
  };

  const refresh = (providerIds: readonly string[]): void => {
    for (const providerId of new Set(providerIds)) {
      void runProbe(providerId);
    }
  };

  return {
    refresh,
    async syncNow(providerIds) {
      const targets = [...new Set(providerIds ?? Object.keys(BUILTIN_CATALOG.providers))];
      const updatedProviders: string[] = [];
      const failedProviders: string[] = [];
      await Promise.all(
        targets.map(async (pid) => {
          const ok = await runProbe(pid);
          if (ok) updatedProviders.push(pid);
          else failedProviders.push(pid);
        }),
      );
      return {
        updatedProviders: updatedProviders.sort(),
        failedProviders: failedProviders.sort(),
      };
    },
    serves(providerId, modelId) {
      const entry = entries.get(providerId);
      if (!entry || now() - entry.at >= entry.ttl) refresh([providerId]);
      if (!entry?.ids) return null;
      return entry.ids.includes(modelId);
    },
    discovered(providerId) {
      const entry = entries.get(providerId);
      if (!entry || now() - entry.at >= entry.ttl) refresh([providerId]);
      return entry?.models ?? null;
    },
  };
}

/** Fold discovery into the declared answer. Discovery can only take a model
 *  AWAY (a served id we have no key for is still unusable), never add one. */
export function applyServedAvailability(
  declared: boolean | undefined,
  serves: boolean | null,
): boolean | undefined {
  if (serves === false) return false;
  return declared;
}

type EnvSource = Record<string, string | undefined> | (() => Record<string, string | undefined>);

function readEnv(source: EnvSource): Record<string, string | undefined> {
  return typeof source === "function" ? source() : source;
}

/** Rich HTTP probe: `GET <baseUrl>/models` returning parsed `DiscoveredModel[]`.
 *  Reads live credentials from SQLite (`credentialsDb`, when provided) and env
 *  so tokens & custom baseUrls saved via Web Settings work immediately. */
export function createProviderCatalogProbe(deps: {
  env: EnvSource;
  credentialsDb?: Database | string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): ProviderCatalogProbe {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 5_000;
  return async (providerId) => {
    const spec: ProviderSpec | undefined = BUILTIN_CATALOG.providers[providerId];
    if (!spec) return null;
    const env = readEnv(deps.env);
    let key: string | undefined;
    let baseUrl: string | undefined;
    let headers: Record<string, string> | undefined;

    if (deps.credentialsDb) {
      const store = createSqliteCredentialStore(deps.credentialsDb, { env });
      const cred = await store.resolve(providerId);
      key = cred?.apiKey;
      baseUrl = cred?.baseUrl;
      headers = cred?.headers;
    } else {
      key =
        env[spec.apiKeyEnv] ?? (providerId === "anthropic" ? env.ANTHROPIC_AUTH_TOKEN : undefined);
      baseUrl =
        env[`${providerId.toUpperCase()}_BASE_URL`] ??
        (providerId === "anthropic" ? env.ANTHROPIC_BASE_URL : undefined);
    }

    if (!key && !headers) return null;
    return fetchProviderModels(
      spec,
      {
        ...(key ? { apiKey: key } : {}),
        baseUrl: baseUrl || spec.baseUrl,
        ...(headers ? { headers } : {}),
      },
      { fetchImpl, timeoutMs },
    );
  };
}

/** Legacy id-only probe wrapper (kept for existing tests & callers). */
export function createProviderModelProbe(deps: {
  env: EnvSource;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): ServedModelProbe {
  const catalogProbe = createProviderCatalogProbe(deps);
  return async (providerId) => {
    const models = await catalogProbe(providerId);
    return models && models.length > 0 ? models.map((m) => m.id) : null;
  };
}

/** Atomically merge one provider's discovered models into `<omaHome>/models-cache.json`
 *  so spawned `oma` ACP children can immediately execute newly discovered model IDs
 *  without restarting or hand-editing `models.yml`. */
export function persistDiscoveredProviderModels(
  omaHome: string,
  providerId: string,
  discovered: readonly DiscoveredModel[],
): void {
  const spec = BUILTIN_CATALOG.providers[providerId];
  if (!spec || discovered.length === 0) return;

  const cachePath = join(omaHome, "models-cache.json");
  let existing: {
    updatedAt?: number;
    providers?: Record<string, { models: ModelSpec[] }>;
    unservedByProvider?: Record<string, string[]>;
  } = {};
  if (existsSync(cachePath)) {
    try {
      const parsed = JSON.parse(readFileSync(cachePath, "utf-8"));
      if (parsed && typeof parsed === "object") existing = parsed;
    } catch {
      existing = {};
    }
  }

  const merged = mergeDiscoveredModelSpecs(spec, discovered);
  const next = {
    updatedAt: Date.now(),
    providers: {
      ...(existing.providers ?? {}),
      [providerId]: { models: merged.models },
    },
    unservedByProvider: {
      ...(existing.unservedByProvider ?? {}),
      ...(merged.drift.unserved.length > 0 ? { [providerId]: merged.drift.unserved } : {}),
    },
  };
  if (merged.drift.unserved.length === 0) {
    delete next.unservedByProvider[providerId];
  }

  mkdirSync(dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  renameSync(tmp, cachePath);
}
