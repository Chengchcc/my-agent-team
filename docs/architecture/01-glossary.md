# Glossary — 术语表

> 核心原则：**一个概念，一个名字**。全项目跨包统一。新增术语更新此文档。

---

## 核心概念

| 术语 | 定义 |
|---|---|
| **Turn** | 一轮对话。从一条 user 消息开始，到 assistant 返回最终文本（不再调 tool）结束。中间可能包含多次 tool 调用 |
| **Thread** | 一条对话线。`{ id, messages }`，messages 是完整的 Message[]。调用方可随时读写、fork、序列化。状态归调用方 |
| **System Prompt** | 定义 agent 人格和行为边界的提示词。在 messages 首位，role=`system`。core 层作为普通 message 传递，adapter 自动提取到 API system 参数 |
| **Context Window** | LLM 能处理的输入 token 上限。agent loop 跑得越久 messages 越长，最终撞墙。ContextManager 负责在撞墙前塑形 |
| **Agent Loop** | `run()` 内部的 while 循环。每步：调 model → 收集 assistant → 执行 tool → 回喂 results → 继续，直到无 tool_use 或 maxSteps |
| **Checkpoint** | 一次持久化保存。Checkpointer.save() 在 tool 边界将完整 thread.messages 落盘，保证崩溃后可恢复 |
| **Interrupt** | Tool 抛 `InterruptSignal` 暂停 agent loop。用于 human-in-the-loop（权限询问、人工审核）。需 Checkpointer 支持 interrupt 能力 |
| **Resume** | `agent.resume(decision)` 从中断恢复。framework 消费 Checkpointer 中保存的 `InterruptState`，补充 tool_result 后继续 loop |
| **Fork** | `agent.fork(messages?, id?)`。复用 model/tools/plugins/checkpointer/contextManager，创建新 thread。用于分支对话、A/B 对比 |
| **Streaming** | LLM 输出的逐 token 传输模式。`AsyncIterable<AIMessageChunk>` 贯穿全栈——L1 协议到 L4 harness 都是同一个流 |
| **State Belongs to Caller** | 核心设计原则。`messages` 数组由调用方持有，framework 只原地推进（push）。调用方可随时读写、fork、持久化 |

---

## 协议层（L1）

| 术语 | 定义 | 文件 |
|---|---|---|
| `Message` | 一条对话记录。`{ role, content }`，content 可以是 `string` 或 `ContentBlock[]` | `packages/core/src/message.ts` |
| `ContentBlock` | 消息内容的原子单元：`TextBlock \| ToolUseBlock \| ToolResultBlock` | 同上 |
| `TextBlock` | `{ type: "text", text: string }` — 纯文本块 | 同上 |
| `ToolUseBlock` | `{ type: "tool_use", id, name, input }` — LLM 发出的工具调用请求。字段对齐 Anthropic Messages API | 同上 |
| `ToolResultBlock` | `{ type: "tool_result", tool_use_id, content, is_error? }` — 工具执行结果。字段对齐 Anthropic Messages API | 同上 |
| `ChatModel` | 模型抽象接口。只有一个方法：`stream(messages, options?) → AsyncIterable<AIMessageChunk>` | `packages/core/src/chat-model.ts` |
| `AIMessageChunk` | 流式输出的增量单元：`{ delta?, done?, stopReason?, usage? }`。delta 可以是 text / tool_use / input_json_delta | 同上 |
| `ChatModelOptions` | `{ signal?, tools? }` — 传给 `model.stream()` 的选项 | 同上 |
| `Tool` | 工具接口。`{ name, description, inputSchema, execute(input, signal?) }` | `packages/core/src/tool.ts` |
| `ToolExecuteResult` | `{ content: string, isError?: boolean }` — tool.execute() 的返回值 | 同上 |
| `RunOptions` | `{ signal?, maxSteps? }` — 传给 `run()` 的选项 | `packages/core/src/run.ts` |

---

## 运行时层（L2）

| 术语 | 定义 | 文件 |
|---|---|---|
| `run()` | 核心 async generator。接收 model + tools + messages，执行 agent loop（调 LLM → 收集 assistant → 执行 tool → 回喂），流式 yield Message | `packages/core/src/run.ts` |
| `collectStream()` | 把 `AsyncIterable<AIMessageChunk>` 收集成 `{ blocks, stopReason, usage }`。供"不想要流，只要最终结果"的场景 | `packages/core/src/stream-utils.ts` |
| agent loop | `run()` 内部的 while 循环：每一步调一次 model，收集完整 assistant message，然后按需执行 tool、append tool_result、继续循环。tool 串行执行 | — |

---

## Adapter 层

| 术语 | 定义 | 文件 |
|---|---|---|
| Adapter | 实现了 `ChatModel` 接口的具体模型接入包。把特定 LLM 提供商的协议翻译成 core 的 `AIMessageChunk` | `packages/adapter-anthropic/` |
| `AnthropicChatModel` | Anthropic 的 ChatModel 实现。用 `@anthropic-ai/sdk` 调 Messages API，SSE events → `AIMessageChunk` | `packages/adapter-anthropic/src/anthropic-chat-model.ts` |
| `toAnthropicTools()` | `Tool[] → Anthropic.Messages.Tool[]` 纯字段映射（name / description / input_schema） | `packages/adapter-anthropic/src/to-anthropic-tools.ts` |
| `input_json_delta` | Anthropic SSE 的 tool input 增量事件类型。`partial_json` 是字符串，需按 `id` 累积后 `JSON.parse`。注意：SDK 的 `InputJSONDelta` 没有 `id` 字段，需通过 `event.index` 映射 | 同上 |

---

## 工具层

| 术语 | 定义 | 文件 |
|---|---|---|
| `tools-common` | 通用工具包。不绑定任何任务领域，被 harness 选用或调用方直接引用 | `packages/tools-common/` |
| `web_fetch` | 取 URL 内容返回纯文本。>20K 字符截断 | `packages/tools-common/src/web-fetch.ts` |
| `web_search` | Tavily 搜索 API。用工厂模式 `createWebSearchTool(apiKey)` | `packages/tools-common/src/web-search.ts` |
| `memory_save` / `memory_recall` | 进程内 KV 存储。`Map<string, string>` 注入。会话级生命周期 | `packages/tools-common/src/memory-save.ts` |
| `read` / `write` | 文件读写。用 `AgentFS.read()` / `AgentFS.write()` | `packages/tools-common/src/afs-tools.ts` |

---

## 框架层（L3）

| 术语 | 定义 | 文件 |
|---|---|---|
| `createAgent()` | 框架入口工厂。`async createAgent(config) → Agent`。若配了 checkpointer + threadId，异步恢复历史。不接受具体 model 类或 tool 实例——只依赖 core 类型 | `packages/framework/src/create-agent.ts` |
| `Agent` | 框架核心对象。`{ thread, run(input, opts?), resume(command, opts?), fork(msgs?, id?) }`。run/resume 返回 `AsyncIterable<AgentEvent>` | 同上 |
| `AgentEvent` | Framework 对外 yield 的流事件 envelope。`{ type, payload }` 统一形状，涵盖对话本体（`message`/`interrupted`/`error`）、实时 delta（`text_delta`/`tool_start`/`tool_end`）、结构化指标（`llm_call`/`tool_call`）和插件扩展（`todo_update` 等）。调用方用 `switch (ev.type)` 判别。详见 [02-framework.md](./02-framework.md) | `packages/framework/src/create-agent.ts` |
| `Interrupt` | 纯领域类型：`{ pendingTool: ToolUseBlock, reason: string, meta?: Record<string, unknown> }`。不含 envelope 元数据——只描述中断态的全部信息。Checkpointer 的 `InterruptState` 可复用 | 同上 |
| `ResumeCommand` | `{ approved: boolean, message?: string }`。传给 `agent.resume()`。比 LangChain Command 简单——无 goto/update。framework 映射为 `tool_result.is_error = !approved` | 同上 |
| `AgentConfig` | `{ model, tools?, systemPrompt?, plugins?, checkpointer?, contextManager?, logger?, threadId? }`。checkpointer 默认 `inMemoryCheckpointer()`，contextManager 默认 `passthroughContextManager()`，logger 默认 `consoleLogger({ level: 'info' })` | 同上 |
| `Thread` | `{ id: string, messages: Message[] }` — 一条对话线。调用方可随时读写、fork、序列化。状态归调用方 | `packages/framework/src/thread.ts` |
| `fork()` | Agent 的方法。`agent.fork(messages?, id?)`。复用 model/tools/plugins/checkpointer/contextManager/logger 共享引用；**强制新 threadId**（同 id throw，无 id auto-uuid）；默认 `messages ?? structuredClone(thread.messages)`。用于分支对话、A/B 对比 | `packages/framework/src/create-agent.ts` |
| `Plugin` | `{ name, hooks }` — 一组事件钩子的封装。Framework 的唯一扩展点。非 middleware、非 decorator、非 event bus | `packages/framework/src/plugin.ts` |
| `PluginHooks` | `{ beforeModel?, afterModel?, beforeTool?, afterTool? }` — 4 个生命周期钩子 | 同上 |
| `HookContext` | `{ threadId, signal?, logger, checkpointer, contextManager }` — 每个钩子的执行上下文，暴露 framework 三大内化能力供 plugin 使用（可读、不可越权重写）。三个字段都**必需**（非可选）。ctx 永远是第一个参数 | 同上 |
| `definePlugin()` | 类型安全的 plugin 构造函数。`definePlugin({ name, hooks }) → Plugin` | 同上 |
| **Transformer** | 一类 plugin 钩子（before*）：返回值有语义，改变数据流。`beforeModel` 返回修饰后的 messages；`beforeTool` 返回 `{ skip?, input?, result? }` | — |
| **Observer** | 一类 plugin 钩子（after*）：副作用收集，返回值被忽略。失败吞掉 + `logger.warn` | — |
| **变形职责分层** | ContextManager 答"哪些 message 进 LLM"（集合选择）；Plugin.beforeModel 答"message 长什么样"（元素修饰）。两层正交，顺序写死：shape → beforeModel → model.stream | — |
| `Checkpointer` | 持久化后端接口。三层成对能力：`save`/`load`（必需）、`saveInterrupt`/`consumeInterrupt`（成对可选）、`appendEvent`/`readEvents`（成对可选）。独立于 Plugin，一个 agent 只有一个。默认 `inMemoryCheckpointer()`。详见 [04-checkpointer.md](./04-checkpointer.md) | `packages/framework/src/checkpointer.ts` |
| `InterruptSignal` | Tool 抛出的中断信号。继承 Error。携带 `reason` + `meta`。**仅**在 `tool.execute()` 抛出时被 framework 识别——其他位置抛按普通故障处理 | 同上 |
| `InterruptState` | 中断状态：`{ pendingTool, ts, meta? }`。由 Checkpointer 持久化（`saveInterrupt`），`agent.resume()` 时消费（`consumeInterrupt` = read + unlink） | 同上 |
| `CheckpointEvent` | Checkpointer 持久化的事件流类型（与 framework yield 的 `AgentEvent` 不同）：user_input / model_start / model_end / tool_start / tool_end / interrupt / resume / run_end。供 UX 回放和审计 | 同上 |
| `ContextManager` | 上下文塑形接口。`shape(ctx, messages) → Message[]`。在每次调 LLM 前决定实际送进去的 messages。不改 thread.messages。`ctx` 暴露 `threadId`/`signal`/`logger`/`model`。默认 passthrough（原样）。详见 [05-context-manager.md](./05-context-manager.md) | `packages/framework/src/context-manager.ts` |
| `ContextManagerContext` | `{ threadId, signal?, logger, model }`。framework 注入 agent 的内化能力给 CM。故意不暴露 `checkpointer`（CM 不读写持久状态）和 `contextManager` 自己（避免循环） | 同上 |
| `countTokens` | `ChatModel` 的可选方法：`countTokens?(messages) → number \| Promise<number>`。由 adapter 实现精确计数，不实现时 `tokenBudgetContextManager` fallback 到字符近似。当前 `adapter-anthropic` 不实现 | `packages/core/src/chat-model.ts` |
| `Logger` | `{ level, debug, info, warn, error }`。level 过滤。默认 level=`info`，输出到 `console`。可注入替换 | `packages/framework/src/logger.ts` |
| `LogLevel` | `'debug' \| 'info' \| 'warn' \| 'error' \| 'silent'` | 同上 |
| **错误隔离** | `before*` 抛错 → 短路 pipeline + 整轮 abort，传播给调用方。`after*` 抛错 → 吞掉 + `logger.warn(pluginName, error)` 后继续 pipeline。`checkpointer.save` 抛错 → 吞掉 + `logger.warn`。规则由 hook 类型（transformer vs observer）决定，不可配置 | — |
| **管道链** | 多个 plugin 挂同一个 `before*` 时，按 plugins 数组顺序依次调用，上一个的返回值作为下一个的输入。一个抛错则短路，后续 plugin 不调 | — |

---

## Backend 层（L5）

| 术语 | 定义 |
|---|---|
| Backend | 常驻进程。管理多个 agent 实例（agentId 表 + workspace 物化），通过 HTTP + SSE 暴露能力给前端。详见 [12-backend.md](./12-backend.md) |
|  `{ spawn(agentId, input, threadId), abort(agentId, threadId), shutdown() }`。Backend 内部的 agent 生命周期管理器，按 agentId 调度 runner | `{ spawn(agentId, input, threadId), abort(agentId, threadId), shutdown() }`。Backend 内部的 agent 生命周期管理器，按 agentId 调度 runner |
| AgentStore | `agentId → AgentSpec` 元数据持久化（DB/KV）。与 framework 的 checkpointer（per-thread messages）不同维度 |
| Runner | Backend 提供的进程入口（≤ 50 行 entry script），把 harness + transport 包成具体部署形态（in-proc / stdio / HTTP / WebSocket） |
| SSE（Server-Sent Events） | `AgentEvent` 流 → `text/event-stream` 的序列化。`ev.type` → `event:`，`ev.payload` → `data:`，机械转译零分支 |
| AgentSpec | Backend ↔ Runner 的 wire 契约对象。zod schema 独立包，带 `schemaVersion` 字段防跨进程版本错配。详见 [13-agent-spec.md](./13-agent-spec.md) |
| Workspace 物化 | Backend 在 `POST /agents` 时 `mkdir` + 从 template 复制 SOUL/AGENTS/MEMORY 等初始文件。harness 不 mkdir |
| **Conversation Projection** | Backend 内部概念。把 run 产生的 assistant/user message 从 [EventLog](./14-event-log.md) **投影到** [Conversation ledger](./15-conversation.md) 的过程。使 agent 回复出现在会话历史中，所有订阅该 conversation 的 surface（web、lark-bot）同步可见。实现见 [12-backend](./12-backend.md)。旧称 D19（M10 第 19 号决策编号） |
| **Conversation Run Lock** | Backend 内部概念。一个 conversation 同时只允许一个 run 在执行。`completeRun` 释放锁，`acquireRun` 获取锁。防并发写 ledger。旧称 D9/D18/D23（M10 决策编号） |
| **Thread ID Derivation** | `${conversationId}:${memberId}` —— 从 conversation + member 派生 threadId 的固定规则。免存映射表，确定性可恢复。旧称 D16（M10 决策编号） |
| **Thread Materialization** | Conversation ledger → agent thread.messages 的物化写入过程。经 `checkpointer.save` 落地，复用标准恢复路径。旧称 D7（M10 决策编号） |

> **D-编号禁止出现在架构文档正文中**。它们是里程碑内部的决策编号（M10 的 D1–D24、M7 的 D1–D4 等），每期独立计数。架构文档中一律使用概念的正式名称（Conversation Projection、Conversation Run Lock 等）。代码注释同理。

---

## Harness 层（L4）

| 术语 | 定义 |
|---|---|
| Harness | 领域专用的、开箱即用的 agent 成品。把 Framework + adapter + tools + plugins 按场景固化。三必要条件：domain-closed + zero-assembly + behavior-locked |
| 形态 A（Code-driven） | system prompt / tool 选型 / plugin 预设写死在 npm 包里。适合领域固定、零配置场景 |
| 形态 B（File-driven） | 领域知识在 workspace 的 markdown 文件里（SOUL.md / AGENTS.md / USER.md / TOOLS.md）。同一份 `harness-generic` 配不同 workspace = 不同领域 agent。**本项目采用** |
| `harness-generic` | 形态 B 的具体实现包。内置 read/write/bash/grep/glob tools + fs-memory + progressive-skill + permission plugins。不固化 model 和 system prompt |
| Framework vs Harness vs Backend | Framework 是装配套件，Harness 是装配成品，Backend 是托管服务。切线：workspace 路径是 backend ↔ harness 唯一传递点 |
| Bootstrap 协议 | Session 启动时 harness 的 6 步初始化：读 6 份 workspace 文件 → 拼 systemPrompt 静态段 → 装配 framework（model + tools + plugins） |
| `permissionPlugin` | 权限询问 UI plugin。**归属 harness**，假设有人机交互界面 |
| Workspace 文件 | 7 类文件控制 agent 行为：SOUL.md / USER.md / TOOLS.md / AGENTS.md / MEMORY.md / memory/YYYY-MM-DD.md / skills/*/SKILL.md。全部可缺失，缺失视为空段 |

---

## 测试

| 术语 | 定义 |
|---|---|
| `echoModel` / `scriptedModel` | 脚本化的 `ChatModel` mock。按 messages 中 assistant 的数量决定返回第几轮脚本（text 或 tool_call）。不调真 API |
| colocated test | 测试文件和被测源文件在同一目录的约定（`src/*.test.ts`），方便导航。全项目统一执行 |
| `tsconfig.test.json` | 继承 build `tsconfig.json`，覆盖 `include` 和 `exclude` 以纳入 `*.test.ts`。typecheck 只跑这个文件 |
| `bun test` | 唯一测试运行器。不引入 vitest / jest |

---

## 项目约定

| 术语 | 定义 |
|---|---|
| workspace | Bun monorepo。`packages/*` + `apps/*` |
| `@my-agent-team/*` | 所有包的 scope 前缀 |
| `.js` extension imports | TS 源文件中相对导入必须写 `.js` 扩展名。`moduleResolution: "NodeNext"` 要求 |
| barrel export | 包的 `index.ts` 导出全部公开 API。**不引入**子路径导出（`@my-agent-team/core/protocols/message`） |
| `bun-types` | Bun 类型声明。需 `types: ["bun-types"]` 的 tsconfig 包括：测试文件、使用 `process.env` 的源码文件 |
| `apps/cli` | 交互式 CLI。临时脚本，只为手工验证。harness 完成后会替换 |