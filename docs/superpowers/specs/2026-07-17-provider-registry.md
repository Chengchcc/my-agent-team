# Spec: Provider 注册制 + Model 对象

## Problem

当前 `createModel()` 硬编码 `new AnthropicChatModel`，存在三个根本问题：

1. **单一 provider 硬编码** -- 加 OpenAI/Google/Bedrock 要改 `agent-helpers.ts`，每加一个 provider 改一次代码
2. **每次调用 new SDK client** -- `createModel` 在 conversation-compose、cron scheduler、loop buildConfig、autoTitle 等处被调用，每次 `new AnthropicChatModel` 都初始化新的 SDK client
3. **agent.modelName 是裸字符串** -- `"claude-sonnet-4"` 不关联 provider，不校验是否存在，无法区分同名模型

## Goal

引入 Provider 注册制，将 model 创建从硬编码改为注册表分派。Agent 配置从裸字符串改为 `{provider, id}` 结构。

## Design

### 核心接口

```typescript
// packages/core/src/provider.ts

/** 一个 LLM 提供商的运行时定义。 */
export interface Provider {
  readonly id: string;          // "anthropic" | "openai" | "custom-xxx"
  readonly name: string;        // 显示名
  readonly baseUrl?: string;

  /** 当前已知模型列表（同步）。静态 provider 返回固定列表，动态 provider 返回缓存。 */
  getModels(): readonly ModelRef[];

  /** 按 model id 创建 ChatModel 实例。Provider 负责缓存/复用 SDK client。 */
  createModel(modelId: string, opts?: ProviderModelOptions): ChatModel;
}

/** Model 引用 -- 替代裸字符串。 */
export interface ModelRef {
  provider: string;     // provider id
  id: string;           // model id, e.g. "claude-sonnet-4"
  name?: string;        // 显示名
  api?: string;         // API 类型标记（预留多 API provider）
}

export interface ProviderModelOptions {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
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
```

### Provider 实现

```typescript
// packages/adapter-anthropic/src/anthropic-provider.ts

export function anthropicProvider(config: {
  apiKey?: string;
  baseUrl?: string;
}): Provider {
  // SDK client 复用 -- 一个 provider 一个 client
  const client = new Anthropic({
    apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY,
    baseURL: config.baseUrl,
  });

  const models: ModelRef[] = [
    { provider: "anthropic", id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
    { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { provider: "anthropic", id: "claude-opus-4-20250514", name: "Claude Opus 4" },
    { provider: "anthropic", id: "claude-haiku-3-5", name: "Claude Haiku 3.5" },
  ];

  // model id -> ChatModel 缓存
  const cache = new Map<string, ChatModel>();

  return {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: config.baseUrl,
    getModels: () => models,
    createModel(modelId: string, opts?: ProviderModelOptions): ChatModel {
      const key = `${modelId}:${opts?.baseUrl ?? ""}`;
      let model = cache.get(key);
      if (!model) {
        model = new AnthropicChatModel({
          model: modelId,
          apiKey: opts?.apiKey ?? config.apiKey,
          baseUrl: opts?.baseUrl ?? config.baseUrl,
        });
        cache.set(key, model);
      }
      return model;
    },
  };
}
```

### ModelRegistry 实现

```typescript
// packages/core/src/model-registry.ts

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
      if (providerId) {
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
```

### Backend 接线

**启动时注册（main.ts）：**

```typescript
// main.ts
const modelRegistry = createModelRegistry();
modelRegistry.register(anthropicProvider({
  apiKey: config.anthropicApiKey,
  baseUrl: config.anthropicBaseUrl,
}));
// 未来: modelRegistry.register(openaiProvider({ ... }));
```

**createModel 改为 registry 查找（agent-helpers.ts）：**

```typescript
// agent-helpers.ts
export function createModel(modelRef: ModelRef | string, registry: ModelRegistry, config: BackendConfig): ChatModel {
  // 向后兼容：裸字符串视为 anthropic provider
  if (typeof modelRef === "string") {
    modelRef = { provider: "anthropic", id: modelRef };
  }
  return registry.createModel(modelRef, {
    apiKey: config.anthropicApiKey,
    baseUrl: config.anthropicBaseUrl,
  });
}
```

**Agent 配置改为 ModelRef（schema.ts）：**

agents 表当前有 `modelName TEXT NOT NULL`。保持 DB schema 不变，但语义从裸字符串改为 `provider/id` 格式：

- 存储格式：`"anthropic/claude-sonnet-4"`（兼容旧数据 `"claude-sonnet-4"` 默认 anthropic）
- 读取时 parse 为 `ModelRef`
- API 响应返回 `{provider, id, name}` 结构

```typescript
// agent domain.ts
export interface AgentRow {
  // ...
  modelProvider: string;   // "anthropic"
  modelName: string;       // "claude-sonnet-4"
}

// 解析 DB 的 modelName 字段
function parseModelRef(raw: string): ModelRef {
  const slashIdx = raw.indexOf("/");
  if (slashIdx > 0) {
    return { provider: raw.slice(0, slashIdx), id: raw.slice(slashIdx + 1) };
  }
  // 向后兼容：无 / 前缀视为 anthropic
  return { provider: "anthropic", id: raw };
}
```

### 新增 API

```
GET /api/models          -- 列出所有 provider + models
  返回: { providers: [{ id, name, models: [{id, name}] }] }

GET /api/models/:provider -- 列出某 provider 的 models
  返回: { models: [{id, name}] }
```

前端 AgentForm 的 model 下拉框改为从 `/api/models` 拉取，按 provider 分组。

### 向后兼容

1. **DB 不迁移** -- `agents.modelName` 保持 TEXT，新数据写 `"provider/id"`，旧数据自动视为 `anthropic/modelName`
2. **createModel 兼容裸字符串** -- `typeof modelRef === "string"` 时默认 anthropic provider
3. **config 不变** -- `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` 仍从 config 读，provider 注册时传入
4. **API 兼容** -- `PATCH /api/agents/:id` 的 `model` 字段仍接受裸字符串（前端旧版本兼容）

### 不做

- **不做 OAuth** -- 服务端用 API key 即可
- **不做动态 model 列表拉取** -- 静态列表够用，未来可加 `provider.refreshModels()`
- **不做 per-agent apiKey** -- 当前全局一个 key，未来加 per-agent 配置时再扩展
- **不改 ChatModel 接口** -- `stream(messages, options)` 契约不变，provider 只负责创建 ChatModel 实例
- **不做 provider 热增删** -- 启动时注册，运行期不变

## Files Touched

### 新增
- `packages/core/src/provider.ts` -- Provider/ModelRef/ModelRegistry 接口
- `packages/core/src/model-registry.ts` -- createModelRegistry 实现
- `packages/adapter-anthropic/src/anthropic-provider.ts` -- anthropicProvider 工厂
- `apps/backend/src/features/models/http.ts` -- GET /api/models 路由
- `apps/backend/src/features/models/service.ts` -- model 列表服务
- `apps/backend/src/features/models/index.ts` -- barrel

### 修改
- `packages/core/src/index.ts` -- 导出 Provider/ModelRef/ModelRegistry
- `packages/adapter-anthropic/src/index.ts` -- 导出 anthropicProvider
- `apps/backend/src/main.ts` -- 创建 modelRegistry + 注册 provider
- `apps/backend/src/features/span/agent-helpers.ts` -- createModel 改为 registry 查找
- `apps/backend/src/features/conversation/conversation-compose.ts` -- 传 registry
- `apps/backend/src/features/cron/scheduler.ts` -- 传 registry
- `apps/backend/src/features/agent/domain.ts` -- parseModelRef 辅助
- `apps/backend/src/features/agent/http.ts` -- AgentForm 响应加 provider
- `apps/backend/src/app.ts` -- 挂载 models 路由
- `apps/web/src/components/AgentForm.tsx` -- model 下拉从 /api/models 拉取
- `apps/web/src/lib/api.ts` -- 加 listModels API
- `apps/web/src/features/agents/hooks.ts` -- 加 useModelList hook

### 不改
- `packages/core/src/chat-model.ts` -- ChatModel 接口不变
- `packages/adapter-anthropic/src/anthropic-chat-model.ts` -- AnthropicChatModel 类不变
- `packages/framework/src/create-agent.ts` -- createAgent 不变（接收 ChatModel）
- DB schema -- 不加表不改列

## Migration Path

1. **Phase 1: 接口 + 注册** -- 定义 Provider/ModelRegistry，anthropicProvider 包装现有 AnthropicChatModel，main.ts 注册。createModel 改为 registry 查找，向后兼容裸字符串。
2. **Phase 2: API + 前端** -- 加 GET /api/models，AgentForm model 下拉改为动态拉取。
3. **Phase 3: agent 配置** -- 新建 agent 时写 `"provider/id"` 格式，旧数据自动兼容。

Phase 1 可以独立上线，不影响现有功能。Phase 2/3 是体验改进。
