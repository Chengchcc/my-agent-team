import type { Model, Provider, ProviderAuth } from "../types.js";
import { createOpenAICompatProvider } from "./openai-compat.js";

export interface CustomProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  models: Model[];
}

export function customProvider(config: CustomProviderConfig): Provider {
  return createOpenAICompatProvider({
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    auth: { apiKey: config.apiKey },
    models: config.models,
  });
}
