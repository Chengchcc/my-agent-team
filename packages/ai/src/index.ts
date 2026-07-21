// API layer - must be imported first to register APIs
import "./api/index.js";

export {
  anthropicMessagesApi,
  getApiImplementation,
  openAICompletionsApi,
  parseSSE,
  registerApi,
} from "./api/index.js";
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
