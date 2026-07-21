// API layer - must be imported first to register APIs
import "./api/index.js";

export {
  type Api,
  type ApiImplementation,
  type ApiStreamOptions,
  type KnownApi,
  type InputModality,
  type Model,
  type ModelCost,
  type ModelRegistry,
  type Provider,
  type ProviderAuth,
} from "./types.js";
export { createModelRegistry } from "./registry.js";
export {
  ANTHROPIC_MODELS,
  anthropicProvider,
  createOpenAICompatProvider,
  type OpenAICompatProviderConfig,
  deepseekProvider,
  customProvider,
  type CustomProviderConfig,
} from "./providers/index.js";
export {
  parseSSE,
  registerApi,
  getApiImplementation,
  anthropicMessagesApi,
  openAICompletionsApi,
} from "./api/index.js";
