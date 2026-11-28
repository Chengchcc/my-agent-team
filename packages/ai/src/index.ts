// ─── Side-effect: register all API implementations (OCP) ───
// Each module calls registerApi() at load time. Importing this barrel
// makes all built-in protocols available — no manual registration needed.
import "./providers/anthropic-messages.js";
import "./providers/openai-completions.js";
import "./providers/openai-responses.js";

export type { ApiImplementation, ChunkConverter } from "./api-registry.js";

// ─── API registry ───
export { getApiImplementation, hasApiImplementation, registerApi } from "./api-registry.js";
// ─── Compat ───
export {
  clampThinkingLevel,
  type ResolvedAnthropicCompat,
  type ResolvedOpenAICompat,
  resolveAnthropicCompat,
  resolveEffort,
  resolveOpenAICompat,
  sanitizeSurrogates,
} from "./compat.js";
// ─── Credential stores (SQLite + env) ───
export {
  createEnvCredentialStore,
  createSqliteCredentialStore,
  readSqliteProviderCredentials,
  type SqliteCredentialStoreOptions,
  type SqliteProviderCredentialsSnapshot,
} from "./credential-store.js";
// ─── Model catalog (runtime config: parseCatalogYAML + BUILTIN_CATALOG) ───
export {
  BUILTIN_CATALOG,
  buildAllModels,
  buildModel,
  type CatalogSpec,
  MODEL_ALIASES,
  type ModelSpec,
  type ProviderSpec,
  parseCatalogYAML,
  resolveModelAlias,
  type ThinkingConfig,
  type ThinkingMode,
} from "./model-catalog.js";
export type { CatalogSyncResult, DiscoveredModel, ModelDrift } from "./model-discovery.js";
// ─── Model discovery (what providers actually serve vs what we declare) ───
export {
  describeDrift,
  diffServedModels,
  fetchProviderModels,
  mergeDiscoveredModelSpecs,
  parseServedModelIds,
  parseServedModels,
  syncCatalogFromProviders,
} from "./model-discovery.js";
export type { ModelRuntimeOptions } from "./model-runtime.js";

// ─── Model runtime ───
export { createModelRuntime } from "./model-runtime.js";
export type { CreateProviderConfig } from "./providers/create-provider.js";
// ─── Provider factory ───
export { createProvider } from "./providers/create-provider.js";
export type { SSEFetchOpts } from "./providers/shared-sse.js";
// ─── Transport ───
export { fetchSSE } from "./providers/shared-sse.js";
// ─── Types ───
export type {
  AnthropicCompat,
  Api,
  CatalogRefreshResult,
  CredentialStore,
  FetchLike,
  InputModality,
  KnownApi,
  Model,
  ModelCompat,
  ModelCost,
  ModelRuntime,
  ModelRuntimeEntry,
  ModelSyncOutcome,
  OpenAICompat,
  Provider,
  ProviderAuth,
  ProviderErrorKind as ProviderErrorKindType,
  ProviderStreamOptions,
  ProviderToolSchema,
  ResolvedCredential,
  SyncModelsOptions,
  ThinkingLevel,
  ThinkingLevelMap,
} from "./types.js";
export { normalizeProviderError, ProviderError, ProviderErrorKind } from "./types.js";
