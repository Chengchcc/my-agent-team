import type { Model, ModelCompat, ThinkingLevel } from "./types.js";

// ── Catalog spec types (sparse input) ──

export type ThinkingMode = "effort" | "budget" | "adaptive";

export interface ThinkingConfig {
  mode: ThinkingMode;
  efforts: readonly string[];
  defaultLevel?: string;
  effortMap?: Record<string, string>;
}

export interface ModelSpec {
  id: string;
  name: string;
  reasoning?: boolean;
  input?: readonly string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  thinking?: ThinkingConfig;
  compat?: ModelCompat;
}

export interface ProviderSpec {
  api: string;
  baseUrl: string;
  apiKeyEnv: string;
  /** Inline literal key from models.yml — fallback when apiKeyEnv is unset. */
  apiKey?: string;
  /** Custom request headers (e.g. Authorization: Bearer ...) from models.yml. */
  headers?: Record<string, string>;
  models: ModelSpec[];
}

export interface CatalogSpec {
  providers: Record<string, ProviderSpec>;
}

const DEFAULTS = {
  reasoning: false,
  input: ["text"],
  contextWindow: 200_000,
  maxTokens: 8_192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const;

function thinkingConfigToMap(tc: ThinkingConfig): Partial<Record<ThinkingLevel, string | null>> {
  const all: ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];
  const supported = new Set(tc.efforts);
  const map: Partial<Record<ThinkingLevel, string | null>> = {};
  for (const lvl of all) {
    const mapped = tc.effortMap?.[lvl];
    if (supported.has(lvl)) {
      map[lvl] = mapped ?? lvl;
    } else if (mapped !== undefined && supported.has(mapped)) {
      map[lvl] = mapped;
    } else {
      map[lvl] = null;
    }
  }
  return map;
}

/** Build a full Model from a sparse spec. */
export function buildModel(
  providerId: string,
  api: string,
  baseUrl: string,
  spec: ModelSpec,
): Model {
  return {
    id: spec.id,
    name: spec.name,
    provider: providerId,
    api,
    baseUrl,
    reasoning: spec.reasoning ?? DEFAULTS.reasoning,
    input: (spec.input ?? DEFAULTS.input) as Model["input"],
    contextWindow: spec.contextWindow ?? DEFAULTS.contextWindow,
    maxTokens: spec.maxTokens ?? DEFAULTS.maxTokens,
    cost: spec.cost ?? DEFAULTS.cost,
    thinkingLevelMap: spec.thinking ? thinkingConfigToMap(spec.thinking) : undefined,
    compat: spec.compat,
  };
}

/** Build all models from a catalog spec. Returns { providerId → { spec, models } }. */
export function buildAllModels(
  catalog: CatalogSpec,
): Record<string, { spec: ProviderSpec; models: readonly Model[] }> {
  const result: Record<string, { spec: ProviderSpec; models: readonly Model[] }> = {};
  for (const [pid, pspec] of Object.entries(catalog.providers)) {
    const modelSpecs = Array.isArray(pspec.models) ? pspec.models : [];
    result[pid] = {
      spec: pspec,
      models: modelSpecs.map((m) => buildModel(pid, pspec.api, pspec.baseUrl, m)),
    };
  }
  return result;
}

// ── Built-in fallback catalog (used when no runtime models.yml exists) ──

export const BUILTIN_CATALOG: CatalogSpec = {
  providers: {
    // ── Anthropic (a厂) — auto-activates with ANTHROPIC_API_KEY ──
    anthropic: {
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      models: [
        {
          id: "claude-opus-4-8",
          name: "Claude Opus 4.8",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1_000_000,
          maxTokens: 128_000,
          cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
          thinking: {
            mode: "adaptive",
            efforts: ["off", "low", "medium", "high", "xhigh"],
            defaultLevel: "low",
            effortMap: { xhigh: "max" },
          },
          compat: { forceAdaptiveThinking: true },
        },
        {
          id: "claude-sonnet-5",
          name: "Claude Sonnet 5",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1_000_000,
          maxTokens: 128_000,
          cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
          thinking: {
            mode: "adaptive",
            efforts: ["off", "low", "medium", "high", "xhigh"],
            defaultLevel: "low",
            effortMap: { xhigh: "max" },
          },
          compat: { forceAdaptiveThinking: true },
        },
        {
          id: "claude-haiku-4-5",
          name: "Claude Haiku 4.5",
          reasoning: false,
          input: ["text", "image"],
          contextWindow: 200_000,
          maxTokens: 8_192,
          cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
        },
      ],
    },
    // ── OpenAI (o厂) — auto-activates with OPENAI_API_KEY ──
    openai: {
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      models: [
        {
          id: "gpt-5.4",
          name: "GPT-5.4",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1_050_000,
          maxTokens: 128_000,
          cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
          thinking: {
            mode: "effort",
            efforts: ["off", "low", "medium", "high"],
            defaultLevel: "medium",
          },
          compat: { maxTokensField: "max_completion_tokens", supportsReasoningEffort: true },
        },
        {
          id: "gpt-5.2",
          name: "GPT-5.2",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 400_000,
          maxTokens: 128_000,
          cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
          thinking: {
            mode: "effort",
            efforts: ["off", "low", "medium", "high"],
            defaultLevel: "medium",
          },
          compat: { maxTokensField: "max_completion_tokens", supportsReasoningEffort: true },
        },
        {
          id: "gpt-5-mini",
          name: "GPT-5 Mini",
          reasoning: false,
          input: ["text", "image"],
          contextWindow: 400_000,
          maxTokens: 128_000,
          cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
          compat: { maxTokensField: "max_completion_tokens" },
        },
      ],
    },
    // ── OpenAI Responses (o-series reasoning models) ──
    openaiResponses: {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      models: [
        {
          id: "o4-mini",
          name: "OpenAI o4 Mini",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 200_000,
          maxTokens: 100_000,
          cost: { input: 1.1, output: 4.4, cacheRead: 0.55, cacheWrite: 1.1 },
          thinking: {
            mode: "effort",
            efforts: ["off", "low", "medium", "high"],
            defaultLevel: "medium",
          },
          compat: { supportsReasoningEffort: true },
        },
      ],
    },
    // ── DeepSeek — auto-activates with DEEPSEEK_API_KEY ──
    deepseek: {
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com/v1",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      models: [
        {
          id: "deepseek-flash",
          name: "DeepSeek Flash",
          reasoning: true,
          // Metadata measured from their /models response (2026-09-23):
          // context 1048576, max 393216, input_modalities [text,image],
          // effort [low,high,max]. Product "max" reaches the provider's
          // "max" via the xhigh→max effortMap below.
          input: ["text", "image"],
          contextWindow: 1_048_576,
          maxTokens: 393_216,
          cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
          thinking: {
            mode: "effort",
            efforts: ["low", "high", "max"],
            defaultLevel: "off",
            effortMap: { xhigh: "max" },
          },
          compat: { thinkingFormat: "deepseek", maxTokensField: "max_tokens" },
        },
        {
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1_048_576,
          maxTokens: 393_216,
          cost: { input: 1, output: 2.5, cacheRead: 0.02, cacheWrite: 0 },
          thinking: {
            mode: "effort",
            efforts: ["low", "high", "max"],
            defaultLevel: "off",
            effortMap: { xhigh: "max" },
          },
          compat: { thinkingFormat: "deepseek", maxTokensField: "max_tokens" },
        },
      ],
    },
    // ── Z.AI (GLM Coding Plan) — auto-activates with ZAI_API_KEY ──
    zai: {
      api: "openai-completions",
      // The CODING-PLAN base, not the general PAYG `/api/paas/v4`: the plan's
      // credentials are validated against this path, and the PAYG one either
      // bypasses plan quota or fails auth (per oh-my-pi's zai descriptor,
      // which rides the coding-plan base for the same reason).
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
      apiKeyEnv: "ZAI_API_KEY",
      models: [
        {
          id: "glm-4.5",
          name: "GLM-4.5",
          reasoning: true,
          input: ["text"],
          contextWindow: 131072,
          maxTokens: 98304,
          cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
          thinking: { mode: "effort", efforts: ["off", "high"], defaultLevel: "off" },
          compat: { thinkingFormat: "zai", maxTokensField: "max_tokens" },
        },
        {
          id: "glm-4.5-air",
          name: "GLM-4.5-Air",
          reasoning: true,
          input: ["text"],
          contextWindow: 131072,
          maxTokens: 98304,
          cost: { input: 0.2, output: 1.1, cacheRead: 0.03, cacheWrite: 0 },
          thinking: { mode: "effort", efforts: ["off", "high"], defaultLevel: "off" },
          compat: { thinkingFormat: "zai", maxTokensField: "max_tokens" },
        },
        {
          id: "glm-4.6",
          name: "GLM-4.6",
          reasoning: true,
          input: ["text"],
          contextWindow: 204800,
          maxTokens: 131072,
          cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
          thinking: { mode: "effort", efforts: ["off", "high"], defaultLevel: "off" },
          compat: { thinkingFormat: "zai", maxTokensField: "max_tokens" },
        },
        {
          id: "glm-4.7",
          name: "GLM-4.7",
          reasoning: true,
          input: ["text"],
          contextWindow: 204800,
          maxTokens: 131072,
          cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
          thinking: { mode: "effort", efforts: ["off", "high"], defaultLevel: "off" },
          compat: { thinkingFormat: "zai", maxTokensField: "max_tokens" },
        },
        {
          id: "glm-5",
          name: "GLM-5",
          reasoning: true,
          input: ["text"],
          contextWindow: 204800,
          maxTokens: 131072,
          cost: { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
          thinking: { mode: "effort", efforts: ["off", "high"], defaultLevel: "off" },
          compat: { thinkingFormat: "zai", maxTokensField: "max_tokens" },
        },
        {
          id: "glm-5-turbo",
          name: "GLM-5-Turbo",
          reasoning: true,
          input: ["text"],
          contextWindow: 200000,
          maxTokens: 131072,
          cost: { input: 1.2, output: 4, cacheRead: 0.24, cacheWrite: 0 },
          thinking: { mode: "effort", efforts: ["off", "high"], defaultLevel: "off" },
          compat: { thinkingFormat: "zai", maxTokensField: "max_tokens" },
        },
        {
          id: "glm-5.1",
          name: "GLM-5.1",
          reasoning: true,
          input: ["text"],
          contextWindow: 200000,
          maxTokens: 131072,
          cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
          thinking: { mode: "effort", efforts: ["off", "high"], defaultLevel: "off" },
          compat: { thinkingFormat: "zai", maxTokensField: "max_tokens" },
        },
        {
          id: "glm-5.2",
          name: "GLM-5.2",
          reasoning: true,
          input: ["text"],
          contextWindow: 1000000,
          maxTokens: 131072,
          cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
          thinking: { mode: "effort", efforts: ["off", "high"], defaultLevel: "off" },
          compat: { thinkingFormat: "zai", maxTokensField: "max_tokens" },
        },
        {
          id: "glm-5.3",
          name: "GLM-5.3",
          reasoning: true,
          input: ["text"],
          contextWindow: 1000000,
          maxTokens: 131072,
          cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
          thinking: { mode: "effort", efforts: ["off", "high"], defaultLevel: "off" },
          compat: { thinkingFormat: "zai", maxTokensField: "max_tokens" },
        },
        {
          id: "glm-5.3-flash",
          name: "GLM-5.3-Flash",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1000000,
          maxTokens: 131072,
          cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
          thinking: { mode: "effort", efforts: ["off", "high"], defaultLevel: "off" },
          compat: { thinkingFormat: "zai", maxTokensField: "max_tokens" },
        },
        {
          id: "glm-5.3-flashx",
          name: "GLM-5.3-FlashX",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1000000,
          maxTokens: 131072,
          cost: { input: 0.37, output: 1.25, cacheRead: 0.075, cacheWrite: 0 },
          thinking: { mode: "effort", efforts: ["off", "high"], defaultLevel: "off" },
          compat: { thinkingFormat: "zai", maxTokensField: "max_tokens" },
        },
      ],
    },
    // ── Groq — fast inference, auto-activates with GROQ_API_KEY ──
    groq: {
      api: "openai-completions",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKeyEnv: "GROQ_API_KEY",
      models: [
        {
          id: "llama-3.3-70b-versatile",
          name: "Llama 3.3 70B (Groq)",
          reasoning: false,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 32_768,
          cost: { input: 0.59, output: 0.79, cacheRead: 0.059, cacheWrite: 0.59 },
          compat: { maxTokensField: "max_completion_tokens" },
        },
      ],
    },
    // ── OpenRouter — gateway to many providers ──
    openrouter: {
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKeyEnv: "OPENROUTER_API_KEY",
      models: [
        {
          id: "anthropic/claude-sonnet-5",
          name: "Claude Sonnet 5 (OpenRouter)",
          reasoning: true,
          input: ["text", "image"],
          contextWindow: 1_000_000,
          maxTokens: 128_000,
          cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
          compat: { thinkingFormat: "openrouter", maxTokensField: "max_tokens" },
        },
      ],
    },
  },
};

// ponytail: old model id → canonical id. Delete after DB migration.
// Existing agent rows may reference model ids from before the catalog
// refresh; this table bridges them to current catalog entries.
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  "claude-sonnet-4-6": "claude-sonnet-5",
  "claude-sonnet-4-20250514": "claude-sonnet-5",
  "claude-opus-4-20250514": "claude-opus-4-8",
  "claude-haiku-3-5": "claude-haiku-4-5",
  "gpt-4o": "gpt-5.2",
  "gpt-4o-mini": "gpt-5-mini",
  "deepseek-chat": "deepseek-flash",
  // Compatibility: this id was published in the catalog for a while but the
  // provider never served it (their list has `deepseek-flash`, no `v4`), so
  // agent rows may carry it. Keep them running rather than failing dispatch.
  "deepseek-v4-flash": "deepseek-flash",
};

/** Resolve a model id through the alias table. Returns the canonical
 *  id if an alias exists, otherwise the original id. */
export function resolveModelAlias(modelId: string): string {
  // Direct match first.
  const direct = MODEL_ALIASES[modelId];
  if (direct) return direct;
  // Try stripping provider prefix: "anthropic/claude-sonnet-4-6" -> check "claude-sonnet-4-6".
  const slash = modelId.indexOf("/");
  if (slash > 0) {
    const bare = modelId.slice(slash + 1);
    const mapped = MODEL_ALIASES[bare];
    if (mapped) return `${modelId.slice(0, slash)}/${mapped}`;
  }
  return modelId;
}

// ── YAML catalog parser (Bun.YAML.parse + structural validation) ──

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse a models.yml text into a validated CatalogSpec. The caller handles
 *  file I/O (reads from `~/.oma/models.yml` or project `.oma/models.yml`). */
export function parseCatalogYAML(text: string): CatalogSpec {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (err) {
    throw new Error(
      `models.yml: invalid YAML (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
  if (!isPlainObject(parsed) || !("providers" in parsed)) {
    throw new Error("models.yml: missing 'providers' key");
  }
  const rawProviders = parsed.providers;
  if (rawProviders === null || rawProviders === undefined) {
    return { providers: {} };
  }
  if (!isPlainObject(rawProviders)) {
    throw new Error("models.yml: providers must be an object");
  }

  const normalized: Record<string, ProviderSpec> = {};
  for (const [pid, rawProvider] of Object.entries(rawProviders)) {
    if (!isPlainObject(rawProvider)) {
      throw new Error(`models.yml: provider "${pid}" must be an object`);
    }
    const p: Record<string, unknown> = { ...rawProvider };
    if (p.header && !p.headers) p.headers = p.header;
    delete p.header;

    if (p.headers !== undefined && !isPlainObject(p.headers)) {
      throw new Error(`models.yml: provider "${pid}".headers must be an object`);
    }
    if (p.models !== undefined && p.models !== null) {
      if (!Array.isArray(p.models)) {
        throw new Error(`models.yml: provider "${pid}".models must be an array`);
      }
      p.models = p.models.map((rawModel, idx) => {
        if (!isPlainObject(rawModel)) {
          throw new Error(`models.yml: provider "${pid}".models[${idx}] must be an object`);
        }
        const m: Record<string, unknown> = { ...rawModel };
        if (m.id === undefined || m.id === null || String(m.id).trim() === "") {
          throw new Error(`models.yml: provider "${pid}".models[${idx}] is missing a valid 'id'`);
        }
        // Coerce unquoted numeric ids/names back to string rather than leaking numbers.
        if (typeof m.id !== "string") m.id = String(m.id);
        if (m.name !== undefined && m.name !== null && typeof m.name !== "string") {
          m.name = String(m.name);
        }
        return m;
      });
    }
    // Single validated boundary cast into ProviderSpec.
    normalized[pid] = p as unknown as ProviderSpec;
  }
  return { providers: normalized };
}
