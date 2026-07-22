import type { Api, Model } from "./types.js";

/** Model config from models.yml or builtin table. */
export interface ModelConfig {
  id: string;
  name: string;
  maxTokens: number;
}

/** Provider config from models.yml or builtin table. */
export interface ProviderConfig {
  id: string;
  api: Api;
  baseUrl: string;
  apiKeyEnv: string;
  models: ModelConfig[];
}

const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Convert ProviderConfig models to full Model objects. */
export function buildModels(providerId: string, config: ProviderConfig): Model[] {
  return config.models.map((m) => ({
    ...m,
    api: config.api,
    provider: providerId,
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ["text"] as const,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    cost: DEFAULT_COST,
  }));
}

/** Built-in provider table used for auto-registration when models.yml is missing. */
export const BUILTIN_PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: {
    id: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    models: [
      { id: "claude-haiku-3-5", name: "Claude 3.5 Haiku", maxTokens: 8192 },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", maxTokens: 8192 },
    ],
  },
  deepseek: {
    id: "deepseek",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: [{ id: "deepseek-chat", name: "DeepSeek Chat", maxTokens: 8192 }],
  },
  openai: {
    id: "openai",
    api: "openai-completions",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    models: [
      { id: "gpt-4o", name: "GPT-4o", maxTokens: 16384 },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", maxTokens: 16384 },
    ],
  },
};
