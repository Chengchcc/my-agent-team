import type { AIMessageChunk, ChatModel, Tool } from "@my-agent-team/core";
import type { Message } from "@my-agent-team/message";

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
  api: Api;
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
  /** Upsert a provider by id (replaces existing). */
  setProvider(provider: Provider): void;
  getProvider(id: string): Provider | undefined;
  getProviders(): readonly Provider[];
  getModels(provider?: string): readonly Model[];
  getModel(provider: string, id: string): Model | undefined;
  createModel(model: Model, auth?: ProviderAuth): ChatModel;
}

/** API 类型标识。 */
export type KnownApi = "anthropic-messages" | "openai-completions";
export type Api = KnownApi | (string & {});

/** API 流选项。 */
export interface ApiStreamOptions {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  tools?: readonly Tool[];
}

/** API 实现接口 -- 每个 API 导出一个 stream 函数。 */
export interface ApiImplementation {
  stream(
    model: Model,
    messages: readonly Message[],
    options?: ApiStreamOptions,
  ): AsyncIterable<AIMessageChunk>;
}
