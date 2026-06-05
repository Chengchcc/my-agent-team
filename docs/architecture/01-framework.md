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
    | { skip?: boolean; input?: unknown; result?: string }
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

## 语义细节

### 1. `beforeModel` 执行时机

**每个 loop step 调一次，在 `model.stream()` 之前执行。** 不是每个 chunk 调一次。

```
for step in 0..maxSteps:
  messages = await fireBeforeModel(ctx, messages)  // ← 一次
  for await chunk in model.stream(messages):
    yield
```

多轮 tool 调用场景（step 1 调 tool，step 2 回文本）——每轮都调 `beforeModel`。

### 2. Checkpointer 应挂 `afterTool`，非 `afterModel`

`afterModel` 时刻，messages 末尾是带 `tool_use` 的 assistant 消息。如果进程在这里崩、恢复后再调 API，Anthropic 会拒绝（assistant 消息末尾有 tool_use 时，必须紧跟 user 消息提供 tool_result）。

`afterTool` 时刻，tool_result 已经 push 进 messages，末尾是 user 角色。**恢复后直接可入 API，不需要额外修复**。

checkpointer 必须挂 `afterTool`。如果未来需要"纯文本对话不调 tool 也要落盘"，加 `afterModel` 支持——此时没有 tool_use，末尾是 text，恢复安全。

### 3. `before*` 管道链

多个插件挂同一个 `before*` 钩子时，**按 plugins 数组顺序依次调用，上一个的返回值作为下一个的输入**：

```ts
async function fireBeforeModel(plugins: Plugin[], ctx: HookContext, msgs: Message[]): Message[] {
  for (const p of plugins) {
    if (p.hooks.beforeModel) {
      msgs = (await p.hooks.beforeModel(ctx, msgs)) ?? msgs;
    }
  }
  return msgs;
}
```

`beforeTool` 同理：上一个插件改写后的 `{ input }` 传给下一个。

### 4. `beforeTool` skip 语义

`{ skip: true }` 时，tool 不执行。Framework 自动 push 一条 `tool_result` 进 messages，以跳过语义告知 LLM：

| 返回值 | Framework 行为 |
|---|---|
| `{ skip: true }` | push `{ type: "tool_result", tool_use_id: call.id, content: "Tool skipped" }` |
| `{ skip: true, result: "权限被拒" }` | push `{ tool_use_id: call.id, content: "权限被拒", is_error: true }` |
| `{ skip: true, result: "后续再说" }` | push `{ tool_use_id: call.id, content: "后续再说" }` |
| `{ input: x }` (无 skip) | 以改写后的 input 执行 tool |
| `undefined` (无返回) | 原样执行 |

`result` 字段让权限拒绝、请求暂缓、用户取消等场景可以干净表达。

### 5. Plugin 错误隔离

- **`before*` 抛错 → 整轮 abort。** `beforeModel`/`beforeTool` 返回的是关键数据，坏了无法继续。错误抛出到 `agent.run()` 的调用方
- **`after*` 抛错 → 吞掉 + `console.warn`。** logger 或 checkpointer 的副作用失败不应拖死 agent。但 framework 会在 warn 中带上 plugin name 和错误信息，方便排查

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
