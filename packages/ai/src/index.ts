// API layer - must be imported first to register APIs
import "./api/index.js";

export {
  anthropicMessagesApi,
  getApiImplementation,
  openAICompletionsApi,
  parseSSE,
  registerApi,
} from "./api/index.js";
export type { ModelConfig, ProviderConfig } from "./builtin-providers.js";
export { BUILTIN_PROVIDERS, buildModels, loadProvider } from "./provider-config.js";
export {
  ANTHROPIC_MODELS,
  anthropicProvider,
  type CustomProviderConfig,
  createOpenAICompatProvider,
  customProvider,
  deepseekProvider,
  type OpenAICompatProviderConfig,
} from "./providers/index.js";
export { createModelRegistry } from "./registry.js";
export { resolveModel } from "./resolve-model.js";
export type {
  Api,
  ApiImplementation,
  ApiStreamOptions,
  InputModality,
  KnownApi,
  Model,
  ModelCost,
  ModelRegistry,
  Provider,
  ProviderAuth,
} from "./types.js";
