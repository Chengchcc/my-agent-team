import type { ChatModel } from "@my-agent-team/core";
import type { Model, Provider, ProviderAuth } from "../types.js";
import { AnthropicChatModel } from "./anthropic-chat-model.js";
import { ANTHROPIC_MODELS } from "./anthropic-models.js";

/** Build an Anthropic Provider. Auth is the default for any createModel call
 *  that doesn't override it. ChatModel instances are cached by model id. */
export function anthropicProvider(auth: ProviderAuth = {}): Provider {
  const defaultApiKey =
    auth.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
  const defaultBaseUrl = auth.baseUrl;

  // ChatModel cache: same model.id -> same instance
  const cache = new Map<string, ChatModel>();

  return {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: defaultBaseUrl,
    getModels: () => ANTHROPIC_MODELS,
    createModel(model: Model, opts?: ProviderAuth): ChatModel {
      const key = model.id;
      let instance = cache.get(key);
      if (!instance) {
        instance = new AnthropicChatModel({
          model: model.id,
          apiKey: opts?.apiKey ?? defaultApiKey,
          baseUrl: opts?.baseUrl ?? defaultBaseUrl,
        });
        cache.set(key, instance);
      }
      return instance;
    },
  };
}
