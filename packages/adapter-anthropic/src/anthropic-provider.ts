import type { ChatModel, ModelRef, Provider, ProviderModelOptions } from "@my-agent-team/core";
import { AnthropicChatModel } from "./anthropic-chat-model.js";

export interface AnthropicProviderConfig {
  apiKey?: string;
  baseUrl?: string;
}

const MODELS: readonly ModelRef[] = [
  { provider: "anthropic", id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
  { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { provider: "anthropic", id: "claude-opus-4-20250514", name: "Claude Opus 4" },
  { provider: "anthropic", id: "claude-haiku-3-5", name: "Claude Haiku 3.5" },
  { provider: "anthropic", id: "claude", name: "Claude (auto)" },
  { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4 (alias)" },
];

export function anthropicProvider(config: AnthropicProviderConfig = {}): Provider {
  const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
  const baseUrl = config.baseUrl;

  // ChatModel cache: same model+baseUrl -> same instance
  const cache = new Map<string, ChatModel>();

  return {
    id: "anthropic",
    name: "Anthropic",
    baseUrl,
    getModels: () => MODELS,
    createModel(modelId: string, opts?: ProviderModelOptions): ChatModel {
      const key = `${modelId}:${opts?.baseUrl ?? baseUrl ?? ""}`;
      let model = cache.get(key);
      if (!model) {
        model = new AnthropicChatModel({
          model: modelId,
          apiKey: opts?.apiKey ?? apiKey,
          baseUrl: opts?.baseUrl ?? baseUrl,
        });
        cache.set(key, model);
      }
      return model;
    },
  };
}
