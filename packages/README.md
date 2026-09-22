# Packages

`packages/` 是可复用的内核，`apps/` 把它们拼起来用。依赖只能向下：叶子包不依赖任何工作区成员，越往上的包越有主张。

包与包之间的完整依赖图（以及每个成员的名字）在根 [`AGENTS.md`](../AGENTS.md) 的 Package dependency graph 一节，`bun run audit:workspace` 会检查它是否点名了每一个成员。本页只给一包一句话。

## 唯一执行链

```text
Product Backend (apps/backend)
→ Agent Run
→ Adapter (packages/adapter-oma-agent)
→ spawn 一次性 oma 子进程 (apps/oh-my-agent)
→ per-Run Runtime
→ BackendRunOutcome (@chengchenccc/agent-contract)
→ Product terminal commit
```

每个 Run 一个子进程，四个后端都是这个形状（`oma` 走 JSONL，`claude` / `pi` / `omp` 各用自己的 argv 与输出格式）。

## 协议与契约

- [`message`](./message/) — `Message` / `MessageRevision` 领域类型与 zod 序列化；`ChatModel`、`Tool`、`ContentBlock`、stream 工具（`collectStream` 等）；`assistantMessageId(runId, ordinal)` 产生 `run:<runId>:assistant:<n>`。整个仓库的叶子节点。
- [`agent-contract`](./agent-contract/) — `AgentBackend` 端口（`execute` / `steer` / `resolveApproval?` / `stop` / `dispose`）、`BackendRunInput` / `BackendRunOutcome`、核心事件与后端种类名单。
- [`api-contract`](./api-contract/) — 跨进程的 SSE 事件 map（`SSEEventMap`、`sseEndpoints`）与飞书消息 schema。HTTP 的 `App` 类型不在这里，它是 `apps/backend/src/app.ts` 导出的。
- [`config`](./config/) — 环境变量 schema 与 `parseEnv()`。

## Runtime 与执行链

- [`ai`](./ai/) — provider 注册表与模型目录、`createModelRuntime()`。协议实现（Anthropic Messages、OpenAI Completions、OpenAI Responses）自己用 fetch 与 SSE 说话，不引任何模型 SDK。
- [`adapter-oma-agent`](./adapter-oma-agent/) — `OmaBackend`：spawn 子进程、stdin/stdout JSONL、steer、停止、spawn 槽位上限、stderr 脱敏。没有子进程池，一个 Run 一个 child，跑完就回收。
- [`adapter-claude-agent`](./adapter-claude-agent/) / [`adapter-pi-agent`](./adapter-pi-agent/) / [`adapter-omp-agent`](./adapter-omp-agent/) — 另外三个后端的适配器。
- [`adapter-mcp`](./adapter-mcp/) — MCP 客户端挂载与工具适配（工具名形如 `mcp__<server>__<tool>`）。

## 编排与沙箱

- [`workflow`](./workflow/) — Workflow DSL 的纯域层：类型与解析、JSON-Logic 子集、图拓扑（any-of 汇合、路由固化、全局合并）、`computeNext` 执行核心、节点运行时契约、编辑器布局。零依赖。
- [`sandbox`](./sandbox/) — workflow script 节点与 oma eval 工具用的进程沙箱。
- [`source-fetch`](./source-fetch/) — git / zip 来源物化的公共底座，技能包与 marketplace 都用它。

## 界面与测试

- [`tui`](./tui/) — oma TUI 背后的终端 UI 框架：差异化渲染、滚动回看、组件库。
- [`test-helpers`](./test-helpers/) — `echoModel()` 这类确定性的 `ChatModel` 测试替身。

## 从哪读起

- **想理解整体**：`message` → `agent-contract` → `adapter-oma-agent`，这条线就是执行链。
- **想加 oma 能力**：先看 `apps/oh-my-agent/src/core/runtime/plugin.ts` 的插件形状，工具照着 `apps/oh-my-agent/src/core/tools/` 里现成的写。
- **想接新模型厂商**：看 [`ai`](./ai/) 的 provider 注册表与 `providers/` 下的协议实现。
- **在做后端**：`agent-contract`（契约）→ `adapter-oma-agent`（子进程边界）→ `apps/backend` 的 agent-run feature（执行编排）。
