import type { ChatModel } from "@my-agent-team/core";
import { getApiImplementation } from "../api/registry.js";
import type { Model, Provider, ProviderAuth } from "../types.js";
import { ANTHROPIC_MODELS } from "./anthropic-models.js";

export function anthropicProvider(auth: ProviderAuth = {}): Provider {
  const defaultApiKey =
    auth.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
  const defaultBaseUrl = auth.baseUrl;

  const cache = new Map<string, ChatModel>();

  return {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: defaultBaseUrl,
    getModels: () => ANTHROPIC_MODELS,
    createModel(model: Model, opts?: ProviderAuth): ChatModel {
      const key = `${model.id}:${opts?.baseUrl ?? defaultBaseUrl ?? ""}`;
      let instance = cache.get(key);
      if (!instance) {
        const impl = getApiImplementation(model.api);
        if (!impl) throw new Error(`Unknown API: ${model.api}`);
        const apiKey = opts?.apiKey ?? defaultApiKey;
        const baseUrl = opts?.baseUrl ?? defaultBaseUrl;
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
