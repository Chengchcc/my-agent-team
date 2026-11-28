import type { Message } from "@chengchenccc/message";
import { resolveModelAlias } from "./model-catalog.js";
import type {
  CatalogRefreshResult,
  CredentialStore,
  Model,
  ModelCost,
  ModelRuntime,
  ModelRuntimeEntry,
  Provider,
} from "./types.js";

export interface ModelRuntimeOptions {
  credentialStore?: CredentialStore;
}

export function createModelRuntime(opts: ModelRuntimeOptions = {}): ModelRuntime {
  const store = opts.credentialStore ?? null;
  const providers = new Map<string, Provider>();
  let cache: CatalogRefreshResult | null = null;

  function buildEntry(
    p: Provider,
    m: {
      id: string;
      name: string;
      reasoning: boolean;
      input: readonly string[];
      contextWindow: number;
      maxTokens: number;
      cost: ModelCost;
    },
  ): ModelRuntimeEntry {
    return {
      providerId: p.id,
      modelId: m.id,
      displayName: m.name,
      reasoning: m.reasoning,
      inputModalities: m.input,
      contextWindow: m.contextWindow,
      maxOutputTokens: m.maxTokens,
      available: p.isModelAvailable ? p.isModelAvailable(m.id) : true,
      cost: m.cost,
    };
  }

  function buildCatalog(): CatalogRefreshResult {
    const models: ModelRuntimeEntry[] = [];
    for (const p of providers.values()) {
      for (const m of p.getModels()) {
        models.push(buildEntry(p, m));
      }
    }
    return { models, timestamp: Date.now() };
  }

  function findModel(provider: Provider, modelId: string): Model | undefined {
    const models = provider.getModels();
    const direct = models.find((m) => m.id === modelId);
    if (direct) return direct;
    const aliased = resolveModelAlias(modelId);
    if (aliased !== modelId) return models.find((m) => m.id === aliased);
    return undefined;
  }

  return {
    registerProvider(provider: Provider): void {
      if (providers.has(provider.id))
        throw new Error(`Provider "${provider.id}" already registered`);
      providers.set(provider.id, provider);
      cache = null;
    },
    setProvider(provider: Provider): void {
      providers.set(provider.id, provider);
      cache = null;
    },
    getProvider(id: string): Provider | undefined {
      return providers.get(id);
    },
    async resolveModel(providerId: string, modelId: string) {
      const provider = providers.get(providerId);
      if (!provider) throw new Error(`Provider "${providerId}" not found`);
      const matched = findModel(provider, modelId);
      if (!matched) throw new Error(`Model "${modelId}" not found`);
      const credential = store ? ((await store.resolve(providerId)) ?? {}) : {};
      return { model: buildEntry(provider, matched), credential };
    },
    async getCatalog() {
      if (cache) return cache;
      return this.refreshCatalog();
    },
    async refreshCatalog(refreshOpts) {
      if (refreshOpts?.sync) {
        await Promise.all(
          [...providers.values()].map(async (p) => {
            if (!p.syncModels) return;
            try {
              const cred = store ? ((await store.resolve(p.id)) ?? {}) : {};
              await p.syncModels({
                apiKey: cred.apiKey,
                baseUrl: cred.baseUrl,
                headers: cred.headers,
                fetchImpl: refreshOpts.fetchImpl,
                timeoutMs: refreshOpts.timeoutMs,
                pruneUnserved: refreshOpts.pruneUnserved,
              });
            } catch {
              /* isolate per-provider sync failure */
            }
          }),
        );
      }
      cache = buildCatalog();
      return cache;
    },
    async *stream(providerId: string, modelId: string, messages: readonly Message[], opts) {
      const provider = providers.get(providerId);
      if (!provider) throw new Error(`Provider "${providerId}" not found`);
      const matched = findModel(provider, modelId);
      if (!matched) throw new Error(`Model "${modelId}" not found`);
      // Credential resolved per request; provider never caches it.
      const credential = store ? ((await store.resolve(providerId)) ?? {}) : {};
      const mergedHeaders =
        credential.headers || opts?.headers
          ? { ...(credential.headers ?? {}), ...(opts?.headers ?? {}) }
          : undefined;
      yield* provider.stream(matched, messages, {
        ...opts,
        apiKey: opts?.apiKey ?? credential.apiKey,
        baseUrl: opts?.baseUrl ?? credential.baseUrl,
        ...(mergedHeaders ? { headers: mergedHeaders } : {}),
      });
    },
  };
}
