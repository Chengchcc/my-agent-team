# L3 Framework — 设计

## 定位

L2 `run()` 是裸的 async generator — 调用方每次都要手动管理 messages、绑定 model 和 tools。L3 Framework 把这一组配置封装成可复用的 `Agent` 实例，提供 thread、plugin、checkpointer 三个正交能力。

**不引入新的心智模型** — Agent 内部还是 while 循环调 L2 `run()`，没有图、没有状态机、没有中间件链。

---

## 模块边界

| 模块 | 职责 | 归属 |
|---|---|---|
| `Thread` | `{ id, messages }` 纯数据 | framework |
| `Plugin` | 4 个生命周期钩子的集合，通过 `definePlugin()` 创建 | framework |
| `HookContext` | `{ threadId, signal }` — 每个钩子的执行上下文 | framework |
| `Agent` | 组合 model + tools + plugins + thread，执行 loop | framework |
| `createAgent()` | 装配 Agent；如果有 threadId + checkpointer plugin，异步恢复历史 | framework |
| `definePlugin()` | 类型安全的 plugin 构造函数 | framework |
| 内置 plugins | slidingWindow、fileCheckpointer、consoleLogger | framework |

依赖方向：framework → core。框架不依赖 adapter-anthropic 或 tools-common。

---

## Agent

```ts
interface Agent {
  readonly thread: Thread;
  run(input: string, options?: RunOptions): AsyncIterable<Message>;
  fork(messages?: Message[], id?: string): Agent;
}
```

- `agent.thread.messages` — 调用方可随时读写、fork、序列化。状态归调用方
- `agent.run(input)` — 把 input 推成 user 消息 → 调 L2 `run()` → 流式 yield
- `agent.fork(messages, id)` — 复用 model/tools/plugins，创建新 thread。用于分支对话

---

## Plugin

```ts
interface Plugin {
  name: string;
  hooks: PluginHooks;
}

interface HookContext {
  threadId: string;
  signal?: AbortSignal;
}

interface PluginHooks {
  beforeModel?(ctx: HookContext, messages: readonly Message[]): Message[] | Promise<Message[]>;
  afterModel?(ctx: HookContext, messages: readonly Message[]): void | Promise<void>;
  beforeTool?(ctx: HookContext, call: ToolUseBlock, messages: readonly Message[]):
    | { skip?: boolean; input?: unknown }
    | void
    | Promise<...>;
  afterTool?(ctx: HookContext, call: ToolUseBlock, result: ToolResultBlock, messages: readonly Message[]):
    | void
    | Promise<void>;
}
```

**区分两类钩子：**

- `before*` — 数据流，返回值有语义：`beforeModel` 返回裁剪后的 messages，`beforeTool` 返回 `{ skip }` 或 `{ input }` 改写参数
- `after*` — 副作用，返回值被忽略，用于落盘/日志/上报

**ctx 永远是第一个参数**，后面才是事件特定的 data。

**不传 `model`** — 插件不需要内省 LLM。需要 token 计数的插件自行引库。

## definePlugin

```ts
definePlugin({ name, hooks }): Plugin
```

只写关心的钩子类型，其余自动推导。不需要手动 import `Plugin` 类型。

---

## 内置 Plugin

| Plugin | 挂载点 | 职责 |
|---|---|---|
| `slidingWindow({ maxTurns })` | `beforeModel` | 保留最近 N 轮，transform messages |
| `fileCheckpointer({ path })` | `afterTool` | 每次 tool 执行后落盘 thread.messages |
| `consoleLogger()` | `afterModel` + `afterTool` | 开发调试日志 |

三个足够触发 Rule of Three。未来扩展不加模块，只加 `definePlugin({ ... })`。

---

## 执行流程

```
agent.run(input)
  messages.push({ role: "user", content: input })
  ↓
  beforeModel(ctx, messages)          // plugin: slidingWindow
  ↓
  model.stream(messages)              // yield 快照
  ↓
  messages.push(assistant msg)
  afterModel(ctx, messages)           // plugin: consoleLogger
  ↓
  [for each tool_use:]
    beforeTool(ctx, call, messages)   // plugin: 鉴权/跳过
    execute tool
    messages.push(tool result)
    afterTool(ctx, call, result, messages)  // plugin: fileCheckpointer, consoleLogger
  ↓
  loop until no tool_use or maxSteps
```

---

## M3 明确不做

- ❌ 不做图/状态机/checkpoint 协议
- ❌ 不做 plugin 间通信优先级/order 控制（plugins 数组顺序即调用顺序）
- ❌ 不做 middleware 链式 invoke（`next()` 模式）
- ❌ 不做 subagent / multi-agent
- ❌ 不做 session / user 管理层
- ❌ 不做 prompt template / 多 system prompt 组合

---

## 与 L2 的关系

L2 `run(model, tools, messages)` 保持不变。L3 是对 L2 的装配层——每次 `agent.run()` 内部调一次 L2 `run()`。上层（L4 Harness）可以替换 L3 或直接调 L2，二者独立。
