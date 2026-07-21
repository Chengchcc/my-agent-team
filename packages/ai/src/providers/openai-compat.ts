import type { ChatModel } from "@my-agent-team/core";
import { getApiImplementation } from "../api/registry.js";
import type { Model, Provider, ProviderAuth } from "../types.js";

export interface OpenAICompatProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  auth: ProviderAuth;
  models: readonly Model[];
}

export function createOpenAICompatProvider(config: OpenAICompatProviderConfig): Provider {
  const cache = new Map<string, ChatModel>();

  return {
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    getModels: () => config.models,
    createModel(model: Model, opts?: ProviderAuth): ChatModel {
      const key = `${model.id}:${opts?.baseUrl ?? config.baseUrl ?? ""}`;
      let instance = cache.get(key);
      if (!instance) {
        const impl = getApiImplementation(model.api);
        if (!impl) throw new Error(`Unknown API: ${model.api}`);
        const apiKey = opts?.apiKey ?? config.auth.apiKey;
        const baseUrl = opts?.baseUrl ?? config.baseUrl;
        instance = {
          id: model.id,
          async *stream(messages, options) {
            yield* impl.stream(model, messages, {
              apiKey,
              baseUrl,
              headers: opts?.headers,
              signal: options?.signal,
              tools: options?.tools,
            });
          },
        };
        cache.set(key, instance);
      }
      return instance;
    },
  };
}
