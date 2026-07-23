# ADR: Agent Runtime 重构

**日期**: 2026-07-22
**状态**: design
**范围**: `packages/agent`（新建）、`packages/framework`（重构）、`packages/harness`（吸收）、`apps/backend`（精简为薄壳）

---

## 问题

### 1. 中间层被架空

```
L3 harness    AgentSession     ← pet/recap/memory 全部挂这层的 subscribe()
L2 framework  createAgent()    ← PluginHooks 只剩 identity/skill/memory 老插件
L1 core       run()            ← 正常运行
```

`framework` 的 `HookContext` 看不到 `modelRegistry` / `settings` / `conversationPort`，所以需要这些能力的 hook 只能绕到 `harness` 层。每加一个新功能都在腐化架构。

### 2. Backend 是 monolithic composition root

`main.ts` 手写所有服务的创建和接线，加一个新功能要改 3 处（插件本身、conversation-compose、main.ts）。Pet/Recap/Memory 的 model 创建逻辑在 conversation-compose 里重复了 3 次。

### 3. 命名暴露实现细节

`Checkpointer`（应该是 `SessionStore`）、`ChatModel`（应该是 `Model`）、`context store`（应该是 `RunState`）——这些名字告诉读者"怎么做的"而不是"做什么的"。

## 决策

### 1. 两层架构

```
旧: harness (AgentSession) → framework (createAgent + PluginHooks) → core (run)
新: agent-runtime (Agent) → core (run)
```

- `AgentSession` 的职责（状态机、steering、retry、compaction）→ `Agent` 类
- `PluginHooks` → 升级为 typed `AgentHooks`（event + handler + return value）
- `Harness` 包 → 撤销，剩余非 Agent 职能（span 管理）留在 backend

### 2. Extension 系统

Backend 从 monolithic composition root 变为薄启动层。所有功能以 Capability 形式注册：

```typescript
interface Capability {
  id: string;
  hooks?: (agent: Agent) => void;        // Agent hooks
  commands?: Record<string, Handler>;    // 命令
  routes?: Record<string, RouteHandler>; // HTTP routes
  slots?: Record<string, SlotComponent>; // 前端组件
}
```

每个 Capability 是一个自包含函数：`(services: Services) => Capability`。

**约定位置（Slot）：**

| Slot | 位置 |
|------|------|
| `conversation:sidebar` | 对话区域右侧 |
| `conversation:composer-before` | 输入框左侧 |
| `agent-detail:tab` | Agent 详情页标签 |
| `settings:section` | Settings 页面卡片 |

### 3. Services 接口

Agent 不直接依赖外部系统。Capability 通过 `Services` 注入外部能力：

```typescript
interface Services {
  modelRegistry: ModelRegistry;
  settings: SettingsService;
  sse: SseBus;
  fs: AgentFs;
  ledgerPort?: ConversationPort;
}
```

### 4. 命名对齐

| 旧 | 新 | 理由 |
|----|-----|------|
| `createAgent()` | `Agent` 类 | 工厂函数 → 一等对象 |
| `PluginHooks` | `AgentHooks` | 明确归属 |
| `HookContext` | `AgentContext` | 上下文是谁的 |
| `AgentSession` | 并入 `Agent` | 一个 Agent 一个实体 |
| `SessionConfig` | `AgentConfig` | session 概念太重 |
| `ChatModel` | `Model`（ai 包已有） | chat 是用法 |
| `Checkpointer` | `SessionStore` | 不暴露实现 |
| `ContextManager` | `ContextPipeline` | 管道，非管理者 |
| `context store` | `RunState` | key-value 的具体用途 |
| `steering / followUp` | `agent.interrupt(input)` | 单一语义 |

### 5. 包结构

```
旧:
@my-agent-team/ai
@my-agent-team/core
@my-agent-team/framework
@my-agent-team/harness

新:
@my-agent-team/ai               ← 不变
@my-agent-team/core             ← 不变
@my-agent-team/agent            ← framework + harness 合并
```

### 6. Agent Hooks 设计

```typescript
interface AgentHooks {
  "before:run":    (ctx: AgentContext) => void;
  "before:model":  (ctx: AgentContext, msgs: Message[]) => Message[];
  "after:model":   (ctx: AgentContext, msgs: Message[], usage: Usage) => void;
  "before:tool":   (ctx: AgentContext, call: ToolCall) => { skip?: boolean; input?: unknown };
  "after:tool":    (ctx: AgentContext, call: ToolCall, result: ToolResult) => void;
  "after:turn":    (ctx: AgentContext, msgs: Message[]) => void;
  "before:stop":   (ctx: AgentContext, msgs: Message[]) => { continue: boolean; reason: string };
}
```

Agent 暴露 `agent.on(event, handler)` / `agent.emit(event, payload)`。

### 改动范围

| 当前 | 目标 |
|------|------|
| `packages/framework` | → `packages/agent` |
| `packages/harness` | → 核心并入 `agent`，其余留在 backend |
| `apps/backend/main.ts` | → 薄启动层，调用 `backend.install(...)` |
| `conversation-compose.ts` | → Agent 生命周期壳，capability 注入 |
| `plugin-pet/recap/memory` | → Capability 函数，挂 `agent.on(...)` |

### 不做

- Pi 的 30+ 细粒度事件 — 只实现我们需要的 7 个
- `before_provider_request` — 先不加，有 demand 再加
- Extension runtime / jiti loader — 先静态 import，后续按需动态加载
- 前端 slot 动态渲染 — Capability 的 slots 字段先定义，前端静态渲染

## 实现顺序

1. Agent 类 (`packages/agent`) — 合并 framework + harness
2. AgentHooks 升级 — typed events + return values
3. Services 接口 — modelRegistry / settings / sse / fs
4. Backend 精简 — 薄启动层 + backend.install()
5. pet/recap/memory 迁移到 Capability 模式
6. 命名对齐全量更新
