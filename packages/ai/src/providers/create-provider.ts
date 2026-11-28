import { getApiImplementation } from "../api-registry.js";
import { buildModel, type ModelSpec } from "../model-catalog.js";
import { fetchProviderModels, mergeDiscoveredModelSpecs } from "../model-discovery.js";
import {
  type Model,
  type ModelSyncOutcome,
  normalizeProviderError,
  type Provider,
  type ProviderAuth,
  type SyncModelsOptions,
} from "../types.js";
import { fetchSSE } from "./shared-sse.js";

export interface CreateProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  auth: ProviderAuth;
  models: readonly Model[];
  /** Default wire API for newly discovered models when `models` is empty. */
  api?: string;
}

const SENSITIVE_HEADER_RE = /(authorization|api[-_]?key|token|secret|cookie|credential)/i;

/** Collect only real credential strings for error redaction — never ordinary
 *  headers like `Content-Type: application/json` or `anthropic-version`. For
 *  `Bearer <token>` / `Basic <token>`, redact `<token>` rather than `"Bearer "`. */
function collectRedactionSecrets(apiKey: string, headers: Record<string, string>): string[] {
  const out = new Set<string>();
  if (apiKey) out.add(apiKey);
  for (const [k, v] of Object.entries(headers)) {
    if (!v || !SENSITIVE_HEADER_RE.test(k)) continue;
    const schemeMatch = v.match(/^(?:Bearer|Basic|Token)\s+(.+)$/i);
    const candidate = (schemeMatch ? schemeMatch[1] : v)?.trim() ?? "";
    if (candidate.length >= 4) out.add(candidate);
  }
  return [...out];
}

function modelToSpec(m: Model): ModelSpec {
  return {
    id: m.id,
    name: m.name,
    reasoning: m.reasoning,
    input: m.input,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    cost: m.cost,
    compat: m.compat,
  };
}

/** Unified provider factory (DIP): depends on ApiImplementation interface +
 *  StreamTransport abstraction. Supports live `syncModels()` against the
 *  provider's `/models` endpoint so catalogs stay fresh automatically. */
export function createProvider(config: CreateProviderConfig): Provider {
  let liveModels: readonly Model[] = [...config.models];
  const unservedIds = new Set<string>();

  return {
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    getModels: () => liveModels,
    isModelAvailable: (modelId: string) => !unservedIds.has(modelId),
    async syncModels(opts?: SyncModelsOptions): Promise<ModelSyncOutcome | null> {
      const api = config.api ?? liveModels[0]?.api ?? "openai-completions";
      const baseUrl = (opts?.baseUrl ?? config.auth.baseUrl ?? config.baseUrl)
        .trim()
        .replace(/\/+$/, "");
      const apiKey = opts?.apiKey ?? config.auth.apiKey;
      const headers =
        config.auth.headers || opts?.headers
          ? { ...(config.auth.headers ?? {}), ...(opts?.headers ?? {}) }
          : undefined;
      const discovered = await fetchProviderModels(
        { api, baseUrl, headers: config.auth.headers },
        { apiKey, baseUrl, headers },
        { fetchImpl: opts?.fetchImpl, timeoutMs: opts?.timeoutMs },
      );
      if (!discovered) return null;

      const existingById = new Map(liveModels.map((m) => [m.id, m]));
      const merged = mergeDiscoveredModelSpecs(
        { api, models: liveModels.map(modelToSpec) },
        discovered,
        { pruneUnserved: opts?.pruneUnserved },
      );

      liveModels = merged.models.map((spec) => {
        const prev = existingById.get(spec.id);
        const built = buildModel(config.id, prev?.api ?? api, baseUrl, spec);
        // Preserve thinkingLevelMap from curated Model if spec did not supply a new one.
        if (prev?.thinkingLevelMap && !built.thinkingLevelMap) {
          return { ...built, thinkingLevelMap: prev.thinkingLevelMap };
        }
        return built;
      });

      unservedIds.clear();
      for (const id of merged.drift.unserved) unservedIds.add(id);

      return {
        confirmed: merged.drift.confirmed,
        unserved: merged.drift.unserved,
        added: merged.drift.undeclared,
      };
    },
    async *stream(model, messages, opts) {
      const impl = getApiImplementation(model.api);
      const { url, headers: apiHeaders, body } = impl.buildRequest(model, messages, opts);

      const apiKey = opts?.apiKey ?? config.auth.apiKey ?? "";
      const baseUrl = (opts?.baseUrl ?? config.baseUrl).trim().replace(/\/+$/, "");

      // Merge: API-specific headers (auth scheme, version) ← provider defaults ← per-request overrides.
      const headers: Record<string, string> = {
        ...apiHeaders,
        ...(config.auth.headers ?? {}),
        ...(opts?.headers ?? {}),
      };
      // Fill apiKey into the API's auth header template if it has a placeholder.
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === "string" && v.includes("{apiKey}"))
          headers[k] = v.replaceAll("{apiKey}", apiKey);
      }
      // Redact only explicit apiKey and values from auth/secret headers so
      // ordinary headers (Content-Type, version) don't corrupt error diagnostics.
      const secrets = collectRedactionSecrets(apiKey, headers);

      const convertChunk = impl.createChunkConverter();
      try {
        for await (const raw of fetchSSE({
          url: baseUrl + url,
          headers,
          body: JSON.stringify(body),
          signal: opts?.signal,
          idleTimeoutMs: opts?.timeoutMs,
        })) {
          for (const chunk of convertChunk(raw)) yield chunk;
        }
        if (convertChunk.flush) {
          for (const chunk of convertChunk.flush()) yield chunk;
        }
      } catch (err) {
        throw normalizeProviderError(err, secrets);
      }
    },
  };
}
