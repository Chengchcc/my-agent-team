# Glossary — 术语表

> 核心原则：**一个概念，一个名字**。全项目跨包跨 milestone 统一。新增术语更新此文档。

---

## 核心概念

| 术语 | 定义 |
|---|---|
| **Turn** | 一轮对话。从一条 user 消息开始，到 assistant 返回最终文本（不再调 tool）结束。中间可能包含多次 tool 调用 |
| **Thread** | 一条对话线。`{ id, messages }`，messages 是完整的 Message[]。调用方可随时读写、fork、序列化。状态归调用方 |
| **System Prompt** | 定义 agent 人格和行为边界的提示词。在 messages 首位，role=`system`。M1 作为普通 message 传递，M2 adapter 自动提取到 API system 参数 |
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
| agent loop | `run()` 内部的 while 循环：每一步调一次 model，收集完整 assistant message，然后按需执行 tool、append tool_result、继续循环。M1 串行执行 tool | — |

---

## Adapter 层

| 术语 | 定义 | 文件 |
|---|---|---|
| Adapter | 实现了 `ChatModel` 接口的具体模型接入包。把特定 LLM 提供商的协议翻译成 M1 的 `AIMessageChunk` | `packages/adapter-anthropic/` |
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
| `read` / `write` | 文件读写。用 `Bun.file()` / `Bun.write()` | `packages/tools-common/src/read.ts` |

---

## 框架层（L3）

| 术语 | 定义 | 文件 |
|---|---|---|
| `createAgent()` | 框架入口工厂。`async createAgent(config) → Agent`。若配了 checkpointer + threadId，异步恢复历史。不接受具体 model 类或 tool 实例——只依赖 core 类型 | `packages/framework/src/create-agent.ts` |
| `Agent` | 框架核心对象。`{ thread, run(input, opts?), resume(decision, opts?), fork(msgs?, id?) }`。run/resume 返回 `AsyncIterable<AgentMessage>` | 同上 |
| `AgentMessage` | `Message \| { type: 'interrupted', pendingTool, reason, meta? }`。interrupted 类型在 tool 抛 InterruptSignal 时 yield | 同上 |
| `ResumeDecision` | `{ approved: boolean, message?: string }`。传给 `agent.resume()` | 同上 |
| `AgentConfig` | `{ model, tools?, systemPrompt?, plugins?, checkpointer?, contextManager?, logger?, threadId? }` | 同上 |
| `Thread` | `{ id: string, messages: Message[] }` — 一条对话线。调用方可随时读写、fork、序列化。状态归调用方 | `packages/framework/src/thread.ts` |
| `fork()` | Agent 的方法。`agent.fork(messages?, id?)`。复用 model/tools/plugins，创建新 thread。默认 `messages ?? structuredClone(thread.messages)`。用于分支对话、A/B 对比 | `packages/framework/src/create-agent.ts` |
| `Plugin` | `{ name, hooks }` — 一组事件钩子的封装。Framework 的唯一扩展点。非 middleware、非 decorator、非 event bus | `packages/framework/src/plugin.ts` |
| `PluginHooks` | `{ beforeModel?, afterModel?, beforeTool?, afterTool? }` — 4 个生命周期钩子 | 同上 |
| `HookContext` | `{ threadId, signal? }` — 每个钩子的执行上下文。ctx 永远是第一个参数 | 同上 |
| `definePlugin()` | 类型安全的 plugin 构造函数。`definePlugin({ name, hooks }) → Plugin` | 同上 |
| **Transformer** | 一类 plugin 钩子（before*）：返回值有语义，改变数据流。`beforeModel` 返回裁剪后的 messages；`beforeTool` 返回 `{ skip?, input?, result? }` | — |
| **Observer** | 一类 plugin 钩子（after*）：副作用收集，返回值被忽略。失败必须吞掉 + `console.warn` | — |
| `Checkpointer` | 持久化后端接口。三层能力：`save`/`load`（必需，崩溃恢复）、`saveInterrupt`/`consumeInterrupt`（可选，human-in-the-loop）、`appendEvent`/`readEvents`（可选，UX 回放）。独立于 Plugin，一个 agent 只有一个。详见 [04-checkpointer.md](./04-checkpointer.md) | `packages/framework/src/checkpointer.ts` |
| `InterruptSignal` | Tool 抛出的中断信号。继承 Error。framework 识别后走 interrupt 流程而非普通 tool 错误。携带 `reason` + `meta` | 同上 |
| `InterruptState` | 中断状态：`{ pendingTool, ts, meta? }`。由 Checkpointer 持久化，`agent.resume()` 时消费 | 同上 |
| `AgentEvent` | 事件流类型：user_input / model_start / model_end / tool_start / tool_end / interrupt / resume / run_end。供 UX 回放和审计 | 同上 |
| `ContextManager` | 上下文塑形接口。`shape(ctx, messages) → Message[]`。在每次调 LLM 前决定实际送进去的 messages。不改 thread.messages。默认 passthrough（原样）。详见 [05-context-manager.md](./05-context-manager.md) | `packages/framework/src/context-manager.ts` |
| `Logger` | `{ level, debug, info, warn, error }`。level 过滤。默认 level=`info`，输出到 `console`。可注入替换 | `packages/framework/src/logger.ts` |
| `LogLevel` | `'debug' \| 'info' \| 'warn' \| 'error' \| 'silent'` | 同上 |
| **错误隔离** | `before*` 抛错 → 整轮 abort，传播给调用方。`after*` 抛错 → 吞掉 + `console.warn(pluginName, error)`。`checkpointer.save` 抛错 → 吞掉 + `console.warn` | — |
| **管道链** | 多个 plugin 挂同一个 `before*` 时，按 plugins 数组顺序依次调用，上一个的返回值作为下一个的输入 | — |

---

## Backend 层（L5）

| 术语 | 定义 |
|---|---|
| Backend | 常驻进程。管理多个 agent 实例，通过 HTTP + SSE 暴露能力给前端。agent pool 维护 threadId → Agent 映射。详见 [08-backend.md](./08-backend.md) |
| Agent Pool | `{ getOrCreate(threadId), remove(threadId), shutdown() }`。Backend 内部的 agent 生命周期管理器 |
| SSE（Server-Sent Events） | `AgentMessage` 流 → `text/event-stream` 的序列化。单向 server→client，用于 run/resume 的实时输出 |

---

## Harness 层（L4）

| 术语 | 定义 |
|---|---|
| Harness | 领域专用的、装配好的 agent 套件。写死了 model 实现、tools 集合、system prompt。对外暴露窄而具体的使用入口 |
| Framework vs Harness | Framework 给白板原料自己装配，Harness 给成品直接用。判定铁律：写死了 system prompt → harness；package.json 里依赖 tools-common → harness；只依赖 core → framework |
| `permissionPlugin` | 命令行权限询问 UI。**归属 harness**，不是 framework plugin——它假设了 CLI 交互环境 |
| `createCodingAgent()` | M4 设想的 harness 入口。`createAgent` + AnthropicChatModel + read/write/bash/grep/glob + coding system prompt 的预制包 |

---

## 测试

| 术语 | 定义 |
|---|---|
| `echoModel` / `scriptedModel` | 脚本化的 `ChatModel` mock。按 messages 中 assistant 的数量决定返回第几轮脚本（text 或 tool_call）。不调真 API |
| colocated test | 测试文件和被测源文件在同一目录的约定（`src/*.test.ts`），方便导航。M1 起全项目执行 |
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
| `bun-types` | Bun 类型声明。需 `types: ["bun-types"]` 的 tsconfig 包括：测试文件、使用 `Bun.file()`/`Bun.write()`/`process.env` 的源码文件 |
| `apps/cli` | M2 的交互式 CLI。临时脚本，只为手工验证。M4 harness 完成后会替换 |
