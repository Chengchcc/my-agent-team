import type { ChatModel } from "./chat-model.js";

/** Model 引用 -- 替代裸字符串。 */
export interface ModelRef {
  provider: string;
  id: string;
  name?: string;
}

export interface ProviderModelOptions {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

/** 一个 LLM 提供商的运行时定义。 */
export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly baseUrl?: string;
  getModels(): readonly ModelRef[];
  createModel(modelId: string, opts?: ProviderModelOptions): ChatModel;
}

/** Provider 注册表。启动时注册，全局复用。 */
export interface ModelRegistry {
  register(provider: Provider): void;
  getProvider(id: string): Provider | undefined;
  getProviders(): readonly Provider[];
  getModels(provider?: string): readonly ModelRef[];
  getModel(provider: string, id: string): ModelRef | undefined;
  createModel(ref: ModelRef, opts?: ProviderModelOptions): ChatModel;
}

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

    getModels(providerId?: string): readonly ModelRef[] {
      if (providerId !== undefined) {
        return providers.get(providerId)?.getModels() ?? [];
      }
      return Array.from(providers.values()).flatMap((p) => p.getModels());
    },

    getModel(provider: string, id: string): ModelRef | undefined {
      return this.getModels(provider).find((m) => m.id === id);
    },

    createModel(ref: ModelRef, opts?: ProviderModelOptions): ChatModel {
      const provider = providers.get(ref.provider);
      if (!provider) {
        throw new Error(`Unknown provider: ${ref.provider}`);
      }
      return provider.createModel(ref.id, opts);
    },
  };
}

/** Parse "provider/model" string into ModelRef. Bare string defaults to "anthropic". */
export function parseModelRef(raw: string): ModelRef {
  const slashIdx = raw.indexOf("/");
  if (slashIdx > 0) {
    return { provider: raw.slice(0, slashIdx), id: raw.slice(slashIdx + 1) };
  }
  return { provider: "anthropic", id: raw };
}
