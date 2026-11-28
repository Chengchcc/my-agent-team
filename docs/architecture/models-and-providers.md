---
title: Models & Providers
description: @chengchenccc/ai 3 wire protocols, BUILTIN_CATALOG vs $OMA_HOME/models.yml isolation, credential precedence, aliases & reasoning effort mapping, and live backend catalog probing
tags: [models, providers, ai, oma, backend]
---

# Models & Providers

Model integration is split cleanly between **`@chengchenccc/ai`** (three polymorphic wire protocols, built-in catalog, aliases, SSE streaming, served-model discovery), **`oma` runtime catalog loading** (with hardened `$OMA_HOME/models.yml` isolation), and **Product Backend's model/provider services** (encrypted credential storage, `oma --list-models`, ACP harness probing, and `/models` availability checks).

## Authoritative files

- `packages/ai/src/api-registry.ts` & `create-provider.ts` & `shared-sse.ts` — Polymorphic protocol registry, `createProvider()`, `fetchSSE()`
- `packages/ai/src/providers/anthropic-messages.ts` — Anthropic Messages wire implementation
- `packages/ai/src/providers/openai-completions.ts` & `compat.ts` — OpenAI Chat Completions + provider dialect quirks
- `packages/ai/src/providers/openai-responses.ts` — OpenAI Responses API wire implementation
- `packages/ai/src/model-catalog.ts` — `BUILTIN_CATALOG` (7 providers) and `MODEL_ALIASES` / `resolveModelAlias()`
- `packages/ai/src/model-discovery.ts` — `parseServedModelIds()`, `diffServedModels()`, `describeDrift()`
- `apps/oh-my-agent/src/core/runtime/runtime-catalog.ts` & `model-effort.ts` — `loadRuntimeCatalog()`, `resolveApiKey()`, `reasoningEffortOptions()`
- `apps/backend/src/features/provider/service.ts` & `http.ts` — `ProviderService`, encrypted DB credentials, `/api/providers`
- `apps/backend/src/features/models/oma-catalog.ts` & `harness-catalog.ts` & `served-models.ts` & `http.ts` — Live catalogs & `/api/{models,harnesses}`

## Three Wire Protocol Implementations (`packages/ai`)

All three providers register via `registerApi()`, stream over `fetchSSE()` (`DEFAULT_SSE_IDLE_TIMEOUT_MS = 120_000`, parses `retry-after-ms` and `Retry-After`, secret-redacts errors via `normalizeProviderError`), and honor per-call `opts.maxTokens` as a downward-only cap `min(max(1, floor(opts.maxTokens)), model.maxTokens, MAX_OUTPUT_TOKENS)` (`MAX_OUTPUT_TOKENS = 131_072`, powering `--max-budget-usd`):

| API Identifier | Endpoint & Auth | Protocol Specifics |
|---|---|---|
| `anthropic-messages` | `POST /messages` (`x-api-key`, `anthropic-version: 2023-06-01`) | Ephemeral `cache_control` on system prompt & last tool; lone-surrogate sanitization; `forceAdaptiveThinking` + `output_config: { effort }`; clamps fixed `thinking.budget_tokens < max_tokens` (omits fixed thinking when `max_tokens <= 1024`); structured output via injected `report_result` tool. |
| `openai-completions` | `POST /chat/completions` (`Authorization: Bearer`, `stream_options.include_usage: true`) | `resolveOpenAICompat()` adapts `max_tokens` vs `max_completion_tokens`, `supportsDeveloperRole`, `reasoning_effort`, and `thinkingFormat`: `"deepseek"` (re-sends `reasoning_content` on assistant history; degrades `json_schema` → `json_object`), `"qwen"` (`enable_thinking`), `"zai"` (`thinking`), `"openrouter"` (`reasoning: { effort }`). |
| `openai-responses` | `POST /responses` (`Authorization: Bearer`, `store: false`) | Structured `input` items (`message`, `function_call`, `function_call_output`); `reasoning: { effort, summary: "auto" }` (clamps `xhigh`/`max` → `high`); `text.format` `json_schema`. |

## Built-in Catalog vs `$OMA_HOME/models.yml`

- **`BUILTIN_CATALOG` (`packages/ai/src/model-catalog.ts`):** ships 7 providers — `anthropic` (`claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5`), `openai` (`gpt-5.4`, `gpt-5.2`, `gpt-5-mini`), `openaiResponses` (`o4-mini`), `deepseek` (`deepseek-flash`, `deepseek-v4-pro`), `zai` (11 GLM models at `https://api.z.ai/api/coding/paas/v4`), `groq` (`llama-3.3-70b-versatile`), and `openrouter` (`anthropic/claude-sonnet-5`).
- **Runtime YAML override (`loadRuntimeCatalog`):** first existing file wins and deep-merges over `BUILTIN_CATALOG` by provider & model ID:
  - **Standalone order:** `$OMA_HOME/models.yml` → `$HOME/.oma/models.yml` → `./.oma/models.yml`.
  - **Hardened product mode (`OMA_WORKSPACE_CATALOG=0`):** reads **only** `$OMA_HOME/models.yml`. Workspace `.oma/models.yml` and `$HOME/.oma/models.yml` are ignored so an untrusted repo or agent run can never hijack `baseUrl` or exfiltrate keys on a subsequent Run.
- **`resolveBaseUrl()`:** honors `ANTHROPIC_BASE_URL` for `anthropic`; strips trailing `/` without auto-appending `/v1` (logs a warning if the last segment does not match `/^v\d+$/`).

## Credential Resolution Order

- **Inside `oma` (`runtime-catalog.ts` → `resolveApiKey`):**
  1. `env[spec.apiKeyEnv]`
  2. Inline `spec.apiKey` in `models.yml`
  3. `env.ANTHROPIC_AUTH_TOKEN` (for `anthropic` only)
  - Providers with no resolved credential are omitted from the active catalog. `OMA_FAKE_PROVIDER=1` swaps all builtins for a deterministic test provider.
- **Inside Product Backend (`features/provider/service.ts`):**
  - Manages 6 `KNOWN_PROVIDERS` (`anthropic`, `openai`, `deepseek`, `zai`, `groq`, `openrouter`) in `settings` (`provider.<id>`, AES-256-GCM encrypted at rest) plus custom `*_API_KEY` env entries (`providerEnv`).
  - `credentialFor(id)` precedence: **DB stored key first** → `process.env[def.apiKeyEnv]`. `getProviderEnv()` merges stored builtin keys with custom keys (custom wins on collision) and injects them into spawned ACP children.

## Model Aliases & Reasoning Effort

- **Aliases (`MODEL_ALIASES`, `resolveModelAlias`):** resolves both bare and `<provider>/<alias>` forms: `claude-sonnet-4-6` / `claude-sonnet-4-20250514` → `claude-sonnet-5`; `claude-opus-4-20250514` → `claude-opus-4-8`; `claude-haiku-3-5` → `claude-haiku-4-5`; `gpt-4o` → `gpt-5.2`; `gpt-4o-mini` → `gpt-5-mini`; `deepseek-chat` / `deepseek-v4-flash` → `deepseek-flash`.
- **Reasoning effort (`model-effort.ts` → `reasoningEffortOptions`):**
  - `"none"` → `{ thinking: { type: "disabled" } }`
  - `"low" | "high" | "max"` → `{ thinking: { type: "adaptive", display: "summarized" }, effort: effort === "max" ? "xhigh" : effort }`
  - Provider compat clamps or remaps levels per model (e.g., DeepSeek maps `xhigh` → `max`; `openai-responses` clamps `xhigh`/`max` → `high`).

## Backend Live Catalog & Served-Model Availability (`features/models/`)

Product Backend aggregates model availability from three live probes (routes: `GET /api/models`, `GET /api/models/readiness`, `GET /api/harnesses`):

1. **Oma CLI catalog (`oma-catalog.ts`):** spawns `oma --list-models` (`15 s` timeout, `1 MiB` output cap), validates via Zod, and caches until `invalidate()`.
2. **ACP harness catalog (`harness-catalog.ts`):** probes each harness via `probeHarnessCatalog()` (`session/new` `configOptions`), cached per harness with `ttlMs = 10 min`, in-flight deduplicated, and per-harness errors isolated into `entry.error`.
3. **Served-model discovery (`served-models.ts`):** probes `GET <baseUrl>/models` (`5 s` timeout, `ttlMs = 10 min`, `failureTtlMs = 60 s`). `serves()` is strictly synchronous and non-blocking (triggers async refresh on miss/stale). `null` (unknown/error/unparseable) **never** disables a model; only an explicit `false` marks a declared model unavailable (`applyServedAvailability`).

## See also

- [ACP Backend Contract](./acp-backend-contract.md) — How harness model refs and `session/setConfigOption` work
- [Oma Runtime](./oma-runtime.md) — `oma --list-models` and per-Run model wiring
- [Security Model](./security-model.md) — `OMA_WORKSPACE_CATALOG=0` and provider key encryption at rest
