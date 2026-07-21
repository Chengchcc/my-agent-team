import type { Model } from "../types.js";
import type { Provider, ProviderAuth } from "../types.js";
import { createOpenAICompatProvider } from "./openai-compat.js";

const DEEPSEEK_MODELS: readonly Model[] = [
  {
    id: "deepseek-chat",
    name: "DeepSeek V3",
    provider: "deepseek",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
    contextWindow: 64_000,
    maxTokens: 8_192,
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek R1",
    provider: "deepseek",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
    contextWindow: 64_000,
    maxTokens: 32_768,
  },
];

export function deepseekProvider(auth: ProviderAuth = {}): Provider {
  return createOpenAICompatProvider({
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: auth.baseUrl ?? "https://api.deepseek.com",
    auth,
    models: DEEPSEEK_MODELS,
  });
}
