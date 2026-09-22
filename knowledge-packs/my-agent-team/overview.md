# my-agent-team Overview

Wiki 是详表的来源：`docs/README.md` 是入口，现状区在 `docs/architecture/`。本文件只给最短的骨架。

my-agent-team 是一个团队级 Agent 运行时。每个 Agent 有一个文件即配置的工作区，运行时可在 oma（自研）/ claude / pi / omp 四个后端之间切换，各自用原生 session 续接上下文。对话在 Web 与飞书双端实时同步。产品侧按 Agent Run 调度执行：一个 Run 一个一次性子进程，账本唯一、终态原子。

## Stack

- Runtime: Bun 1.3.x，TypeScript 6.x ESM（NodeNext）
- Monorepo: Turborepo v2
- Backend: Elysia HTTP，Drizzle ORM + SQLite
- Frontend: Next.js 15 App Router，React Query v5，shadcn/ui + Tailwind v4
- Lint/format: Biome + ESLint

## Layer map

- L5 端：Web UI 与 IM bot 通过 HTTP/SSE 与 backend 通信
- L4 Backend：Elysia 服务，负责产品事实与执行控制面（`apps/backend`）
- L3 Adapter：`packages/adapter-*`，子进程边界（spawn / JSONL RPC / steer / stop / approval）
- L2 Runtime：`apps/oh-my-agent/src/core`，模型与工具循环、插件、compaction
- L1 协议：Message / ChatModel / Tool / ContentBlock

## Top-level directories

- `apps/backend`：Elysia 服务、各功能域、Workflow 触发调度
- `apps/web`：Next.js App Router 界面与 BFF
- `apps/oh-my-agent`：oma CLI（产品侧以 `--mode rpc` 一次性子进程运行）
- `apps/lark-bot`：飞书集成
- `packages/message`：Message 本体与 ChatModel/Tool 契约
- `packages/agent-contract`：与 spawn 无关的 `AgentBackend` 契约（四个 adapter 实现）
- `packages/workflow`：Workflow DSL 纯域层（节点图、JSON-Logic、computeNext）
- `packages/sandbox`：workflow script 节点与 oma eval 工具的进程沙箱
- `packages/ai`：provider 与模型注册表
- `packages/source-fetch`：git / zip 来源物化基础
- `packages/tui`：oma TUI 的终端 UI 工具包
- `packages/adapter-*`：各后端的子进程适配器（oma / claude / pi / omp / MCP 客户端）
- `skills/`、`knowledge-packs/`：随仓库分发的技能包与内置知识包
- `docs/`：项目 wiki（`architecture/` 现状、`adr/` 决策、`guides/` 指南、`roadmap.md` 路线）
