import { buildModels, type ProviderConfig } from "./builtin-providers.js";
import { anthropicProvider } from "./providers/anthropic.js";
import { createOpenAICompatProvider } from "./providers/openai-compat.js";
import type { Model, Provider } from "./types.js";

/** Load a provider from config. Returns undefined if api key env var is not set. */
export function loadProvider(config: ProviderConfig): Provider | undefined {
  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) return undefined;

  const models: Model[] = buildModels(config.id, config);
  const auth = { apiKey, baseUrl: config.baseUrl };

  switch (config.api) {
    case "anthropic-messages": {
      const provider = anthropicProvider(auth);
      return { ...provider, getModels: () => models, name: config.id };
    }
    default: {
      return createOpenAICompatProvider({
        id: config.id,
        name: config.id,
        baseUrl: config.baseUrl,
        auth,
        models,
      });
    }
  }
}

export type { ProviderConfig } from "./builtin-providers.js";
export { BUILTIN_PROVIDERS, buildModels } from "./builtin-providers.js";
