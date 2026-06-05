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
| 内置 plugins | 无 — Plugin 全是用户/harness 定义 | framework |
| 内置 checkpointer | inMemoryCheckpointer（默认）、fileCheckpointer | framework |
| 内置 contextManager | passthroughContextManager（默认）| framework |
| 内置 logger | consoleLogger（默认），包装 `console` | framework |

依赖方向：framework → core。框架不依赖 adapter-anthropic 或 tools-common。

---

## Agent

```ts
type AgentMessage =
  | Message
  | { type: 'interrupted'; pendingTool: ToolUseBlock; reason: string; meta?: unknown };

interface Agent {
  readonly thread: Thread;
  run(input: string, options?: RunOptions): AsyncIterable<AgentMessage>;
  /** 从 interrupt 恢复，传入 ResumeCommand 告知 framework 如何处理挂起的 tool */
  resume(command: ResumeCommand, options?: RunOptions): AsyncIterable<AgentMessage>;
  fork(messages?: Message[], id?: string): Agent;
}

/** 调用方控制中断后如何恢复。比 LangChain Command 简单——没有 goto/update */
interface ResumeCommand {
  /** 填入 tool_result.content 的内容 */
  content: string;
  /** 用户拒绝时设 true */
  isError?: boolean;
}
```

- `agent.thread.messages` — 调用方可随时读写、fork、序列化。状态归调用方
- `agent.run(input)` — 把 input 推成 user 消息 → 执行 agent loop → 流式 yield
- `agent.resume(decision)` — 从 interrupt 恢复，补充 tool_result 后继续 loop
- `agent.fork(messages, id)` — 复用 model/tools/plugins/checkpointer/contextManager，创建新 thread

**并发保护：** 同一 Agent 同时只能有一个 `run()`/`resume()` 在执行。第二个调用抛错 —— `"Agent is already running. Use fork() for concurrent conversations."`。

**Abort 行为：** signal 在入口处检查（已 abort 不 push user 消息）。中途 abort 保留已完成内容，不 rollback。

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
  logger: Logger;
  checkpointer: Checkpointer;
  contextManager: ContextManager;
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

Framework 内化能力（不是 plugin）。承担状态持久化、human-in-the-loop、UX 回放。详见 **[04-checkpointer.md](./04-checkpointer.md)**。

---

## ContextManager

Framework 内化能力（不是 plugin）。在每次调 LLM 前决定"实际送进去的 messages 是什么"的策略层。默认 `passthroughContextManager`（原样传）。详见 **[05-context-manager.md](./05-context-manager.md)**。

---

## definePlugin

```ts
definePlugin({ name, hooks }): Plugin
```

只写关心的钩子类型，其余自动推导。不需要手动 import `Plugin` 类型。

---

## Logger

Framework 内化能力。可注入，默认 `consoleLogger`。

```ts
type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

interface Logger {
  level: LogLevel;
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}
```

- `createAgent` 不传 `logger` → 用 `consoleLogger`（level=`info`，包装 `console`）
- framework 内部调用前检查 `level`：低于当前 level 的方法不执行（如 level=`warn` 时 `debug`/`info` 为空操作）
- 错误隔离（`after*` / `checkpointer.save` 抛错）→ `logger.warn`
- Interrupt 触发 / Resume 恢复 → `logger.info`
- 内部调试信息（hook fire、loop step）→ `logger.debug`
- 用户可替换（`pino`、`winston`）或禁用（`noopLogger`，level=`silent`）

---

## 内置 Checkpointer

`inMemoryCheckpointer` 是默认实现（进程内 Map）。`fileCheckpointer({ dir })` 提供文件持久化（state.json + events.jsonl + interrupt.json）。详见 **[04-checkpointer.md](./04-checkpointer.md)**。

---

## 内置 ContextManager

`passthroughContextManager` 是默认实现（原样传）。`slidingWindowContextManager`、`tokenBudgetContextManager`、`toolResultTruncator`、`summarizingContextManager` 提供可组合的裁剪策略。详见 **[05-context-manager.md](./05-context-manager.md)**。

---

## 执行流程

```
agent.run(input)
  signal.throwIfAborted()                      // 早抛,thread 不污染
  messages.push({ role: "user", content: input })
  checkpointer.save(...)                       // 持久化完整版
  ↓
  loop:
    shapedMessages = contextManager.shape(...)  // 空间塑形
    beforeModel(ctx, shapedMessages)            // plugin: 修饰
    ↓
    model.stream(shapedMessages)               // yield 快照
    ↓
    messages.push(assistant msg)                // push 到完整版
    afterModel(ctx, messages)                  // plugin: consoleLogger
    ↓
    [for each tool_use:]
      beforeTool(ctx, call, messages)           // plugin: 鉴权/跳过
      execute tool
      messages.push(tool result)
      afterTool(ctx, call, result, messages)   // plugin: consoleLogger
      checkpointer.save(...)                   // 持久化完整版
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
