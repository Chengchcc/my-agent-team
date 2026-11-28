import type { CatalogSpec, ModelSpec, ProviderSpec, ThinkingConfig } from "./model-catalog.js";
import type { FetchLike, InputModality, ModelCompat, ModelCost, ProviderAuth } from "./types.js";

/**
 * Live model discovery and catalog auto-sync against provider `/models`
 * endpoints.
 *
 * Real provider shapes handled:
 * - DeepSeek:    `{"data":[{"id","name","context_window","max_output_tokens","input_modalities","effort":{"supported_levels"}}]}`
 * - Anthropic:   `{"data":[{"id","display_name","max_input_tokens","max_tokens","capabilities":{...}}]}`
 * - OpenRouter:  `{"data":[{"id","name","context_length","top_provider":{"max_completion_tokens"},"pricing":{"prompt","completion",...},"architecture":{"input_modalities"}}]}`
 * - OpenAI/Groq/Z.AI/generic OpenAI-compatible: `{"data":[{"id","object","created","owned_by","context_window"?,"active"?}]}`
 *
 * Any unreachable or unparseable provider resolves to `null` (fail-open),
 * so an offline or misbehaving endpoint never empties the existing catalog.
 */

export interface DiscoveredModel {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly input?: readonly InputModality[];
  readonly reasoning?: boolean;
  readonly thinking?: ThinkingConfig;
  readonly cost?: Partial<ModelCost>;
}

export interface ModelDrift {
  /** Declared and served: offer it. */
  confirmed: string[];
  /** Declared but NOT served. */
  unserved: string[];
  /** Served by provider but not yet declared in the static catalog. */
  undeclared: string[];
}

export interface CatalogSyncResult {
  readonly catalog: CatalogSpec;
  readonly drifted: Record<string, ModelDrift>;
  readonly updatedProviders: string[];
  readonly failedProviders: string[];
  readonly unservedByProvider: Record<string, string[]>;
}

const NON_CHAT_MODEL_RE =
  /(?:^|\/)(?:whisper|tts|dall-e|gpt-image|text-embedding|embedding|omni-moderation|text-moderation|babbage|davinci|sora|gpt-.*-realtime|gpt-.*-audio|gpt-.*-transcribe)/i;

const REASONING_MODEL_HINT_RE =
  /(?:^|\/)(?:o[134](?:-|$)|deepseek-r1|deepseek-reasoner|deepseek-v4|deepseek-flash|claude-(?:opus|sonnet)-4|claude-sonnet-5|glm-[45]|qwq|r1)/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function posInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

function parsePerMillionPrice(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v * 1e6;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n) && n >= 0) return Math.round(n * 1e6 * 1e6) / 1e6;
  }
  return undefined;
}

function parseInputModalities(raw: unknown): InputModality[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: InputModality[] = [];
  for (const item of raw) {
    if (item === "text" || item === "image") {
      if (!out.includes(item)) out.push(item);
    }
  }
  return out.length > 0 ? out : undefined;
}

function parseEffortConfig(raw: Record<string, unknown>): ThinkingConfig | undefined {
  const effort = isRecord(raw.effort) ? raw.effort : null;
  const levels = effort && Array.isArray(effort.supported_levels) ? effort.supported_levels : null;
  if (!levels || levels.length === 0) return undefined;
  const efforts = levels.filter((l): l is string => typeof l === "string" && l.length > 0);
  if (efforts.length === 0) return undefined;
  return {
    mode: "effort",
    efforts,
    defaultLevel: "off",
    ...(efforts.includes("max") ? { effortMap: { xhigh: "max" } } : {}),
  };
}

function parseDiscoveredEntry(
  raw: unknown,
  opts?: { includeNonChat?: boolean },
): DiscoveredModel | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) return null;
  if (raw.active === false) return null;
  if (!opts?.includeNonChat && NON_CHAT_MODEL_RE.test(id)) return null;

  const name =
    typeof raw.display_name === "string" && raw.display_name.trim()
      ? raw.display_name.trim()
      : typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim()
        : undefined;

  const topProvider = isRecord(raw.top_provider) ? raw.top_provider : null;
  const contextWindow =
    posInt(raw.context_window) ??
    posInt(raw.max_input_tokens) ??
    posInt(raw.context_length) ??
    (topProvider ? posInt(topProvider.context_length) : undefined);

  const maxTokens =
    posInt(raw.max_output_tokens) ??
    posInt(raw.max_tokens) ??
    posInt(raw.max_completion_tokens) ??
    (topProvider ? posInt(topProvider.max_completion_tokens) : undefined);

  const arch = isRecord(raw.architecture) ? raw.architecture : null;
  const caps = isRecord(raw.capabilities) ? raw.capabilities : null;
  let input =
    parseInputModalities(raw.input_modalities) ??
    (arch ? parseInputModalities(arch.input_modalities) : undefined);
  if (!input && caps && isRecord(caps.image_input) && caps.image_input.supported === true) {
    input = ["text", "image"];
  }

  const thinking = parseEffortConfig(raw);
  let reasoning: boolean | undefined;
  if (thinking) {
    reasoning = true;
  } else if (caps && isRecord(caps.thinking) && typeof caps.thinking.supported === "boolean") {
    reasoning = caps.thinking.supported;
  } else if (typeof raw.reasoning === "boolean") {
    reasoning = raw.reasoning;
  }

  let cost: Partial<ModelCost> | undefined;
  if (isRecord(raw.pricing)) {
    const pIn = parsePerMillionPrice(raw.pricing.prompt);
    const pOut = parsePerMillionPrice(raw.pricing.completion);
    const pCacheR = parsePerMillionPrice(raw.pricing.input_cache_read);
    const pCacheW = parsePerMillionPrice(raw.pricing.input_cache_write);
    if (pIn !== undefined || pOut !== undefined || pCacheR !== undefined || pCacheW !== undefined) {
      cost = {
        ...(pIn !== undefined ? { input: pIn } : {}),
        ...(pOut !== undefined ? { output: pOut } : {}),
        ...(pCacheR !== undefined ? { cacheRead: pCacheR } : {}),
        ...(pCacheW !== undefined ? { cacheWrite: pCacheW } : {}),
      };
    }
  }

  return {
    id,
    ...(name ? { name } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(input ? { input } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(thinking ? { thinking } : {}),
    ...(cost ? { cost } : {}),
  };
}

/** Parse rich model descriptors from a provider's `/models` JSON payload. */
export function parseServedModels(
  payload: unknown,
  opts?: { includeNonChat?: boolean },
): DiscoveredModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  const seen = new Set<string>();
  const out: DiscoveredModel[] = [];
  for (const item of payload.data) {
    const parsed = parseDiscoveredEntry(item, opts);
    if (!parsed || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    out.push(parsed);
  }
  return out;
}

/** Ids a provider reports, tolerant of the shapes seen in the wild. */
export function parseServedModelIds(payload: unknown): string[] {
  return parseServedModels(payload, { includeNonChat: true }).map((m) => m.id);
}

/** Compare the declared catalogue against what the provider just told us. */
export function diffServedModels(
  declaredIds: readonly string[],
  servedIds: readonly string[],
): ModelDrift {
  const served = new Set(servedIds);
  const declared = new Set(declaredIds);
  return {
    confirmed: declaredIds.filter((id) => served.has(id)),
    unserved: declaredIds.filter((id) => !served.has(id)),
    undeclared: servedIds.filter((id) => !declared.has(id)),
  };
}

/** One line for logs and ops views; "" when nothing drifted. */
export function describeDrift(providerId: string, drift: ModelDrift): string {
  const parts: string[] = [];
  if (drift.unserved.length > 0) {
    parts.push(`declared but not served: ${drift.unserved.join(", ")}`);
  }
  if (drift.undeclared.length > 0) {
    parts.push(`served but not declared: ${drift.undeclared.join(", ")}`);
  }
  if (parts.length === 0) return "";
  return `${providerId}: ${parts.join("; ")}`;
}

function discoveryHeaders(
  api: string,
  auth: ProviderAuth,
  specHeaders?: Record<string, string>,
): Record<string, string> {
  const base: Record<string, string> =
    api === "anthropic-messages"
      ? { "x-api-key": auth.apiKey ?? "", "anthropic-version": "2023-06-01" }
      : { Authorization: `Bearer ${auth.apiKey ?? ""}` };
  return { ...base, ...(specHeaders ?? {}), ...(auth.headers ?? {}) };
}

/** Probe `GET <baseUrl>/models` for one provider. Returns `null` when
 *  credentials are missing, the provider is unreachable, or the payload cannot
 *  be parsed (fail-open so existing catalogs are never wiped). */
export async function fetchProviderModels(
  spec: Pick<ProviderSpec, "api" | "baseUrl" | "headers">,
  auth: ProviderAuth,
  opts?: { fetchImpl?: FetchLike; timeoutMs?: number; includeNonChat?: boolean },
): Promise<DiscoveredModel[] | null> {
  if (!auth.apiKey && !auth.headers && !spec.headers) return null;
  const baseUrl = (auth.baseUrl ?? spec.baseUrl).trim().replace(/\/+$/, "");
  if (!baseUrl) return null;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  const res = await fetchImpl(`${baseUrl}/models`, {
    headers: discoveryHeaders(spec.api, auth, spec.headers),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => null);
  if (!res?.ok) return null;
  const payload: unknown = await res.json().catch(() => null);
  if (!payload) return null;
  const models = parseServedModels(payload, { includeNonChat: opts?.includeNonChat });
  return models.length > 0 ? models : null;
}

/** Infer sensible provider-level compat flags for a newly discovered model
 *  from sibling models already declared on the same provider. */
function inferProviderCompat(spec: Pick<ProviderSpec, "api" | "models">): ModelCompat | undefined {
  for (const sibling of spec.models) {
    if (sibling.compat) return { ...sibling.compat };
  }
  return undefined;
}

/** Merge live discovered models into a provider's declared `ModelSpec[]`.
 *  - Confirmed models keep curated pricing/compat and refresh live metadata.
 *  - Brand-new models served by the provider are automatically synthesized
 *    inheriting the provider's compat defaults.
 *  - Unserved declared models are retained unless `pruneUnserved: true`. */
export function mergeDiscoveredModelSpecs(
  spec: Pick<ProviderSpec, "api" | "models">,
  discovered: readonly DiscoveredModel[],
  opts?: { pruneUnserved?: boolean },
): { models: ModelSpec[]; drift: ModelDrift } {
  const declaredIds = spec.models.map((m) => m.id);
  const discoveredById = new Map(discovered.map((d) => [d.id, d]));
  const drift = diffServedModels(
    declaredIds,
    discovered.map((d) => d.id),
  );
  const inheritedCompat = inferProviderCompat(spec);
  const models: ModelSpec[] = [];

  for (const declared of spec.models) {
    const live = discoveredById.get(declared.id);
    if (!live) {
      if (!opts?.pruneUnserved) models.push(declared);
      continue;
    }
    const mergedCost =
      live.cost && declared.cost
        ? {
            input:
              declared.cost.input > 0
                ? declared.cost.input
                : (live.cost.input ?? declared.cost.input),
            output:
              declared.cost.output > 0
                ? declared.cost.output
                : (live.cost.output ?? declared.cost.output),
            cacheRead:
              declared.cost.cacheRead > 0
                ? declared.cost.cacheRead
                : (live.cost.cacheRead ?? declared.cost.cacheRead),
            cacheWrite:
              declared.cost.cacheWrite > 0
                ? declared.cost.cacheWrite
                : (live.cost.cacheWrite ?? declared.cost.cacheWrite),
          }
        : (declared.cost ??
          (live.cost
            ? {
                input: live.cost.input ?? 0,
                output: live.cost.output ?? 0,
                cacheRead: live.cost.cacheRead ?? 0,
                cacheWrite: live.cost.cacheWrite ?? 0,
              }
            : undefined));

    models.push({
      ...declared,
      ...(live.name && !declared.name ? { name: live.name } : {}),
      ...(live.contextWindow !== undefined ? { contextWindow: live.contextWindow } : {}),
      ...(live.maxTokens !== undefined ? { maxTokens: live.maxTokens } : {}),
      ...(live.input ? { input: live.input } : {}),
      ...(live.thinking && !declared.thinking ? { thinking: live.thinking } : {}),
      ...(mergedCost ? { cost: mergedCost } : {}),
    });
  }

  for (const id of drift.undeclared) {
    const live = discoveredById.get(id)!;
    models.push({
      id: live.id,
      name: live.name ?? live.id,
      reasoning: live.reasoning ?? REASONING_MODEL_HINT_RE.test(live.id),
      ...(live.input ? { input: live.input } : {}),
      ...(live.contextWindow !== undefined ? { contextWindow: live.contextWindow } : {}),
      ...(live.maxTokens !== undefined ? { maxTokens: live.maxTokens } : {}),
      ...(live.thinking ? { thinking: live.thinking } : {}),
      ...(live.cost
        ? {
            cost: {
              input: live.cost.input ?? 0,
              output: live.cost.output ?? 0,
              cacheRead: live.cost.cacheRead ?? 0,
              cacheWrite: live.cost.cacheWrite ?? 0,
            },
          }
        : {}),
      ...(inheritedCompat ? { compat: inheritedCompat } : {}),
    });
  }

  return { models, drift };
}

/** Probe all authenticated providers in `catalog` in parallel and return an
 *  auto-updated `CatalogSpec` with drift & unserved diagnostics. Unreachable
 *  or unauthenticated providers keep their existing declarations unchanged. */
export async function syncCatalogFromProviders(
  catalog: CatalogSpec,
  opts: {
    resolveAuth: (
      providerId: string,
      spec: ProviderSpec,
    ) => Promise<ProviderAuth | null> | ProviderAuth | null;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    pruneUnserved?: boolean;
  },
): Promise<CatalogSyncResult> {
  const providers: Record<string, ProviderSpec> = { ...catalog.providers };
  const drifted: Record<string, ModelDrift> = {};
  const updatedProviders: string[] = [];
  const failedProviders: string[] = [];
  const unservedByProvider: Record<string, string[]> = {};

  await Promise.all(
    Object.entries(catalog.providers).map(async ([pid, spec]) => {
      const auth = await opts.resolveAuth(pid, spec);
      if (!auth || (!auth.apiKey && !auth.headers && !spec.headers)) return;
      const discovered = await fetchProviderModels(spec, auth, {
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.timeoutMs,
      });
      if (!discovered) {
        failedProviders.push(pid);
        return;
      }
      const merged = mergeDiscoveredModelSpecs(spec, discovered, {
        pruneUnserved: opts.pruneUnserved,
      });
      providers[pid] = { ...spec, models: merged.models };
      drifted[pid] = merged.drift;
      updatedProviders.push(pid);
      if (merged.drift.unserved.length > 0) {
        unservedByProvider[pid] = merged.drift.unserved;
      }
    }),
  );

  return {
    catalog: { providers },
    drifted,
    updatedProviders: updatedProviders.sort(),
    failedProviders: failedProviders.sort(),
    unservedByProvider,
  };
}
