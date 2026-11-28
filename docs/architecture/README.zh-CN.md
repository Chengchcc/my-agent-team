---
title: 架构现状索引（中文入口）
description: CrewDesk 架构文档中文导航入口：按任务路由到对应规范页、核心术语表与全仓不变量（深层子系统规范以英文单源为准）
tags: [index, overview, conventions, zh]
---

# 架构文档索引

> **语言说明**：**简体中文入口** · [English Index](./README.md)。为避免双语漂移与 Agent 检索重复，**三篇入口页**（[索引](./README.zh-CN.md)、[系统总览](./system-overview.zh-CN.md)、[设计哲学](./design-philosophy.zh-CN.md)）提供中英双版；其余深层子系统规范均为**英文唯一真源**。

本目录描述 CrewDesk（`my-agent-team`）**此刻**的代码现状。每篇文档都锚定到仓库真实文件路径、Schema、默认值与不变量，并由 `bun run audit:docs`（`scripts/audit-docs.ts`）在 CI 中校验死链、frontmatter、禁用旧词与代码路径存在性。

- **未做事项与路线图**：[`../roadmap.md`](../roadmap.md)
- **历史决策记录（含已作废/被取代）**：[`../adr/README.md`](../adr/README.md)
- **本地开发与常用命令**：[`../guides/development.md`](../guides/development.md)

## 按任务找页

| 要做的事 | 按顺序阅读 |
|---|---|
| 快速建立全局心智 | [系统总览（中文）](./system-overview.zh-CN.md) → [设计哲学（中文）](./design-philosophy.zh-CN.md) → [Data Model](./data-model.md) → [Agent Run Execution](./agent-run-execution.md) |
| 动代码前必读规则 | [设计哲学（中文）](./design-philosophy.zh-CN.md) → [E2E Contract Rules](./e2e-contract-rules.md) → [DB Type-Safe Rules](./db-typesafe-rules.md) |
| 改 SQLite 表结构或迁移 | [DB Type-Safe Rules](./db-typesafe-rules.md) → [Data Model](./data-model.md) |
| 改对话账本、成员路由或 Agent Context | [Conversation & Context](./conversation-and-context.md) → [Agent Run Execution](./agent-run-execution.md) → [Data Model](./data-model.md) |
| 改 Run 生命周期、排队、HITL 或重启恢复 | [Agent Run Execution](./agent-run-execution.md) → [ACP Backend Contract](./acp-backend-contract.md) → [Data Model](./data-model.md) |
| 改 ACP 引擎接入（`oma` / `claude` / `pi` / `omp`） | [ACP Backend Contract](./acp-backend-contract.md) → [Workspaces & Projects](./workspaces-and-projects.md) → [Oma Runtime](./oma-runtime.md) |
| 改 PA+Worker 派单、Product MCP 或 Proposal | [Team Coordination](./team-coordination.md) → [Agent Run Execution](./agent-run-execution.md) → [Proactive & Knowledge](./proactive-and-knowledge.md) |
| 改事项、Git Wiki、统一召回、提醒或注意力债 | [Proactive & Knowledge](./proactive-and-knowledge.md) → [Data Model](./data-model.md) → [Team Coordination](./team-coordination.md) |
| 改工作区、MCP 加密目录、Worktree 或 Coding 终端 | [Workspaces & Projects](./workspaces-and-projects.md) → [Security Model](./security-model.md) → [Web Surface](./web-surface.md) |
| 改 Agentic Workflow 或 `artifacts://` | [Workflow Engine](./workflow.md) → [Data Model](./data-model.md) → [Workspaces & Projects](./workspaces-and-projects.md) |
| 改技能、技能包、Oma 插件或审批门控 | [Skills & Plugins](./skills-and-plugins.md) → [Oma Runtime](./oma-runtime.md) → [Security Model](./security-model.md) |
| 改 `oma` CLI、Agent Loop、工具、扇出或 TUI | [Oma Runtime](./oma-runtime.md) → [Skills & Plugins](./skills-and-plugins.md) → [Compaction](./compaction.md) |
| 改模型厂商、协议实现或 `models.yml` | [Models & Providers](./models-and-providers.md) → [ACP Backend Contract](./acp-backend-contract.md) → [Oma Runtime](./oma-runtime.md) |
| 改上下文压缩（Compaction）或工具裁剪 | [Compaction](./compaction.md) → [Conversation & Context](./conversation-and-context.md) → [Oma Runtime](./oma-runtime.md) |
| 改 AHP 实时协议或跨面关联索引 | [AHP Surface Contract](./ahp-surface-contract.md) → [E2E Contract Rules](./e2e-contract-rules.md) |
| 改 Web 控制台、BFF、i18n 或对话画布 | [Web Surface](./web-surface.md) → [AHP Surface Contract](./ahp-surface-contract.md) → [E2E Contract Rules](./e2e-contract-rules.md) |
| 改飞书 Bot、Run 卡片、文档评论或接入向导 | [Lark Surface](./lark-surface.md) → [AHP Surface Contract](./ahp-surface-contract.md) → [Proactive & Knowledge](./proactive-and-knowledge.md) |
| 查安全模型、沙箱、密钥加密与安全债务 | [Security Model](./security-model.md) → [Workspaces & Projects](./workspaces-and-projects.md) |
| 查 DI 组装、`oma gateway`、systemd 或线上排障 | [Operations & Gateway](./operations-and-gateway.md) → [Security Model](./security-model.md) |

## 文档清单

### 入口与架构规则
- [系统总览（中文）](./system-overview.zh-CN.md) · [English](./system-overview.md) — PA + Worker 拓扑、所有权划分、唯一执行链与失败原则
- [设计哲学（中文）](./design-philosophy.zh-CN.md) · [English](./design-philosophy.md) — 八条原则、动手前三组检查、红旗信号与决策顺序
- [E2E Contract Rules](./e2e-contract-rules.md) — 跨进程类型单一真源规则与 CI 门禁
- [DB Type-Safe Rules](./db-typesafe-rules.md) — Drizzle Schema → Service → HTTP 类型链与迁移生成纪律

### 后端控制面与团队协作
- [Data Model](./data-model.md) — `backend.db` 全部 30 张表、部分唯一索引、幂等键、原子事务与库外文件
- [Conversation & Context](./conversation-and-context.md) — 对话账本、1:1 房间路由、子会话、AgentContext 树/分支与 `cli_session_ref`
- [Agent Run Execution](./agent-run-execution.md) — `enqueueAndAcquire`、9 阶段派单状态机、看门狗、持久化 HITL、`retry-commit` 与崩溃恢复
- [ACP Backend Contract](./acp-backend-contract.md) — 单一 `acp` 协议边界、四引擎注册表、事件映射与 `HeldPermission`
- [Team Coordination](./team-coordination.md) — PA/Worker 隔离、Product Tools MCP（32+3+2 工具）、意图维度派单、全双工协作、验收门与 Proposal
- [Proactive & Knowledge](./proactive-and-knowledge.md) — 提醒、事项（Requirement）、Git Wiki、统一召回、跨进程记忆与注意力债

### 工作区、编排与扩展
- [Workspaces & Projects](./workspaces-and-projects.md) — Agent 工作区布局、Workspace Bridge、加密 MCP 目录、Worktree 与安全推送、Coding 终端
- [Workflow Engine](./workflow.md) — Workflow DSL、5 类节点、13 运算符 JSON-Logic、波次并行、返工预算门、Cron/Webhook 触发与 `artifacts://`
- [Skills & Plugins](./skills-and-plugins.md) — 按角色分流的内置技能、Skill Pack 安装同步状态机、渐进式技能发现、Oma 插件信任矩阵与权限模式

### Oma 运行时与模型
- [Oma Runtime](./oma-runtime.md) — `oma` 四种模式、核心循环、原生工具与 MCP 挂载、子代理扇出、自主记忆、TUI 分层与 Goal/Loop/Plan
- [Models & Providers](./models-and-providers.md) — `@chengchenccc/ai` 三种线协议、内置目录与 `models.yml`、凭据解析与在线模型探测
- [Compaction](./compaction.md) — 四类触发入口、CJK 感知切点与工具配对保护、六段摘要与确定性状态块、后端 `/compact`

### 多端契约与交互面
- [AHP Surface Contract](./ahp-surface-contract.md) — `/ws/ahp` 传输与鉴权、快照/动作流、`_meta` 扩展与跨面关联索引
- [Web Surface](./web-surface.md) — Next.js 15 控制台、BFF、Eden Treaty、导航 IA、i18n 词典、分栏预览与 E2E 消息链路
- [Lark Surface](./lark-surface.md) — 官方 Channel SDK、文档评论线程、三层准入、本地 10 表、CardKit 流式卡片与 systemd 托管

### 安全、运维与历史快照
- [Security Model](./security-model.md) — 单操作员威胁模型、四道正交防线、OS 沙箱与实时安全债务清单
- [Operations & Gateway](./operations-and-gateway.md) — 后端 DI 组装、`oma gateway` 打包与升级、systemd 模板与故障定位手册
- [Backend Kinds Gate 0 Snapshot](./backend-kinds-gate0.md) — 2026-08-12/13 历史实测归档（非现状契约）

## 核心概念（全仓术语基准）

| 术语 | 定义 |
|---|---|
| **Agent** | 团队成员：身份（`SOUL.md`/`USER.md`）、配置（`agent.yml`）、技能与记忆都存在工作区文件中；`role` 为 `"front"`（PA）或 `"worker"`。 |
| **PA（前台 / Front Desk）** | 面向人的超级助理（`role !== "worker"`），负责管注意力、建事项、选人派单、答阻塞问题与维护 Git Wiki；代码层物理移除所有代码/Shell 工具。 |
| **Worker（工人）** | 专职执行成员（`role === "worker"`），在独立子会话与隔离 Git worktree 中干活，可混用 4 个 ACP 引擎。 |
| **Conversation** | 依托 `conversation_ledger` 的 1:1 房间（由 `conversation.agent_id` 归属）；根房间面向人，子房间（`parent_conversation_id`）承载派单执行。 |
| **Agent Context** | 按 `(conversation, agent)` 隔离的只追加树（`agent_context_tree`/`entry`/`branch`），指向账本消息与摘要节点。 |
| **Agent Run** | 分支上的唯一产品级执行身份（`agent_run`），每次 Run 启动一个一次性 ACP 子进程。 |
| **ACP Harness** | 注册在 `ACP_AGENTS` 中的四个 CLI 引擎（`oma`、`claude`、`pi`、`omp`），共用唯一的 `acp` 后端客户端。 |
| **Product Tool** | 后端通过 MCP 提供的产品能力（`product-tools` / `agent-config` / `workflow`），每次 Run 签发独立 Bearer Token，结束即吊销。 |
| **Requirement（事项）** | 跨会话与跨 Run 持续追踪的稳定工作目标（`requirement`），并拥有项目工作区副本（`workspace`）。 |
| **Proposal（提议）** | Agent 通过配置/流程 MCP 发出的未落盘变更（`proposal`），必须经人显式审阅保存（「提议 ≠ 保存」）。 |
| **Wiki** | 产品级 Git 驱动的共享 Markdown 知识库（`<dataDir>/wiki`），取代已下线的知识包（ADR 0078）。 |
| **Workflow** | 声明式节点图（`*.workflow.json`），支持 `start`/`end`/`agent`/`script`/`human`、JSON-Logic 路由、并行波次、返工预算与 Cron/Webhook 触发。 |
| **AHP** | Agent Host Protocol（`/ws/ahp`）：后端与 Web/飞书之间唯一的实时状态镜像契约。 |

## 全局不变量

1. **Product Backend 是唯一事实源**：Web、飞书与 Coding 终端只渲染后端事实，端侧只保本地投递与 UI 状态。
2. **一次 Run = 一个一次性 ACP 子进程**：没有跨 Run 常驻代理进程；多轮续接靠各引擎不透明的 `cli_session_ref` / `native_session_ref`。
3. **同一 Context Branch 同时只有一个活跃 Run**：由 `enqueueAndAcquire` 事务与部分唯一索引 `idx_agent_run_active_branch` 双重强制。
4. **流式输出不入账，终态提交单事务原子落盘**：`(agent_run_id, message_index)` 保证幂等，账本、Context、分支 CAS 与 Run 状态一次提交。
5. **Fail-Closed 人在环审批与代码级角色隔离**：审批/追问先落 `pending_action` 再推送且超时默认拒绝；前台无执行工具；`project_push` 仅推 `agent/<runId>`；Proposal 永不自动覆盖配置。
6. **子进程内部机制不对产品泄露**：后端只依赖 5 个 `AgentBackend` 契约方法，不依赖 `oma` 内部 loop、compaction 或 todo 文件。
