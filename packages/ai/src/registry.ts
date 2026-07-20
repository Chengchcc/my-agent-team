import type { ChatModel } from "@my-agent-team/core";
import type { Model, ModelRegistry, Provider, ProviderAuth } from "./types.js";

export function createModelRegistry(): ModelRegistry {
  const providers = new Map<string, Provider>();

  return {
    register(provider: Provider): void {
      if (providers.has(provider.id)) {
        throw new Error(`Duplicate provider: ${provider.id}`);
      }
      providers.set(provider.id, provider);
    },

    getProvider(id: string): Provider | undefined {
      return providers.get(id);
    },

    getProviders(): readonly Provider[] {
      return Array.from(providers.values());
    },

    getModels(providerId?: string): readonly Model[] {
      if (providerId !== undefined) {
        return providers.get(providerId)?.getModels() ?? [];
      }
      return Array.from(providers.values()).flatMap((p) => p.getModels());
    },

    getModel(provider: string, id: string): Model | undefined {
      return this.getModels(provider).find((m) => m.id === id);
    },

    createModel(model: Model, auth?: ProviderAuth): ChatModel {
      const provider = providers.get(model.provider);
      if (!provider) {
        throw new Error(`Unknown provider: ${model.provider}`);
      }
      return provider.createModel(model, auth);
    },
  };
}
