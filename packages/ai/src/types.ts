import type { ChatModel } from "@my-agent-team/core";

/** 模型输入模态 */
export type InputModality = "text" | "image";

/** 模型成本（$/million tokens） */
export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Model 元数据对象 - 替代裸字符串。 */
export interface Model {
  id: string;
  name: string;
  provider: string;
  baseUrl?: string;
  reasoning: boolean;
  input: readonly InputModality[];
  cost: ModelCost;
  contextWindow: number;
  maxTokens: number;
}

/** Provider 认证配置 */
export interface ProviderAuth {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

/** 一个 LLM 提供商的运行时定义。 */
export interface Provider {
  readonly id: string;
  readonly name: string;
  readonly baseUrl?: string;
  getModels(): readonly Model[];
  createModel(model: Model, auth?: ProviderAuth): ChatModel;
}

/** Provider 注册表。启动时注册，全局复用。 */
export interface ModelRegistry {
  register(provider: Provider): void;
  getProvider(id: string): Provider | undefined;
  getProviders(): readonly Provider[];
  getModels(provider?: string): readonly Model[];
  getModel(provider: string, id: string): Model | undefined;
  createModel(model: Model, auth?: ProviderAuth): ChatModel;
}
