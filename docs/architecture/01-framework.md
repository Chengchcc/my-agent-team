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
| `Checkpointer` | `load`/`save` — 持久化后端，独立于 plugin | framework |
| `HookContext` | `{ threadId, signal }` — 每个钩子的执行上下文 | framework |
| `Agent` | 组合 model + tools + plugins + checkpointer + thread，执行 loop | framework |
| `createAgent()` | 装配 Agent；如果有 threadId + checkpointer，异步恢复历史 | framework |
| `definePlugin()` | 类型安全的 plugin 构造函数 | framework |
| 内置 plugins | slidingWindow、consoleLogger | framework |
| 内置 checkpointer | fileCheckpointer | framework |

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

**并发保护：** 同一 Agent 同时只能有一个 `run()` 在执行。第二个调用直接抛错 —— `"Agent is already running. Use fork() for concurrent conversations."`。fail-fast，错误信息自带指引。

**Abort 行为：** signal 在 `run()` 入口处先检查（已 abort 时 user 消息不会 push，thread 不受影响）。中途 abort 时，messages 中已 push 的内容（user input + 已完成的 assistant turn）保留不 rollback —— framework 无法判断调用方意图是重试还是撤销，决策权归调用方。调用方可 `thread.messages.pop()` 手动撤销。

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

---

## Checkpointer

```ts
interface Checkpointer {
  load(threadId: string): Promise<Message[] | null>;
  save(threadId: string, messages: Message[]): Promise<void>;
}
```

**Checkpointer 是独立字段，不是 plugin。**

- `load` 是主动查询（framework 问 "这个 thread 有历史吗？"），不是事件回调——和 4 个钩子性质不同
- `save` 时机由 framework 决定：每次 afterTool 之后调 `checkpointer.save()`
- 一个 agent 只有一个 Checkpointer —— 不需要数组 + 优先级
- `createAgent` 如果配了 `threadId` + `checkpointer`，先调 `load()` 恢复 messages；无则创建空 thread

**不是 plugin 的理由：** plugin 是事件回调（发生时被调），checkpointer 是被动查询（framework 来问）。把 load 塞进 plugin 数组会产生"第一个非 null 就是答案"的隐式优先级，违反 "plugins 数组顺序即调用顺序，无 priority" 的纪律。

---

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
| `consoleLogger()` | `afterModel` + `afterTool` | 开发调试日志 |

两个内置 plugin + 内置 checkpointer 合起来触发 Rule of Three。未来扩展不加模块，只加 `definePlugin({ ... })`。

---

## 内置 Checkpointer

| Checkpointer | 实现 |
|---|---|
| `fileCheckpointer({ path })` | `save` 写 JSON 文件，`load` 读并 parse |

调用方可以用任意存储后端（redis/memory/db）实现 `Checkpointer` 接口，替换内置实现。

---

## 执行流程

```
agent.run(input)
  signal.throwIfAborted()                      // 早抛,thread 不污染
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
    afterTool(ctx, call, result, messages)     // plugin: consoleLogger
    checkpointer.save(thread.id, messages)     // framework 自动调
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

### 2. Checkpointer save 时机

Checkpointer 的 `save()` 在每次 `afterTool` 之后由 framework 调用，不是 plugin 钩子。

选择此时机的理由：`afterTool` 时刻，tool_result 已经 push 进 messages，末尾是 user 角色。如果进程崩在这之后，**恢复后直接可入 Anthropic API，不需要修复**。

反之如果 save 在 `afterModel` 时刻，末尾可能是带 tool_use 的 assistant 消息——Anthropic API 要求 assistant 消息末尾有 tool_use 时必须紧跟 user 提供 tool_result。崩在这点恢复后 API 直接报 400。

如果未来需要"纯文本对话不调 tool 也要落盘"，在 loop 结束（无 tool_use）之后加一次 `save()`。

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
- **`after*` 抛错 → 吞掉 + `console.warn`。** logger 等副作用失败不应拖死 agent。framework 在 warn 中带上 plugin name 和错误信息
- **Checkpointer save 抛错 → 吞掉 + `console.warn`。** 一个坏的磁盘不应让 agent 不可用

### 6. 并发 `run()` — fail-fast 抛错

同一 Agent 同时只能有一个 `run()` 在执行。第二个调用直接抛错，不排队、不 silent-overwrite：

```
Error: Agent is already running. Use fork() for concurrent conversations.
```

选择抛错而非队列的理由：

- 队列意味着第二个 input 在未来执行，但执行时 messages 状态已变（第一个 run 还在追加消息）——隐式状态污染，比抛错更难调试
- `fork()` 正是为并发场景设计的：拷贝 thread，创建独立 agent
- fail-fast 让开发期就能发现调用方滥用

### 7. Abort 的 messages 状态

signal 在 `run()` 入口处先检查 —— 已 abort 时 user 消息不 push，thread 不受影响。

中途 abort：L2 `run()` 中断，但已完成的 assistant turn（M1 行为：abort 时不 push 部分 block）和已 push 的 user input 保留在 messages 中。framework 不 rollback —— 无法判断调用方意图是重试还是撤销。

调用方契约：
- 重试：`messages` 不变，再次 `run()` 同样 input
- 撤销：`thread.messages.pop()` 手动移除多余 user 消息
- 不管：messages 末尾多一条 user，下次 `run()` 追一条新 user —— API 接受，自动合并理解

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
