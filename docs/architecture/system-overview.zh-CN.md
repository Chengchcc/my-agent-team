---
title: 系统总览（中文）
description: CrewDesk 端到端架构总览：PA + Worker 团队拓扑、容器与进程视图、所有权划分、唯一 Agent Run 执行链、失败原则与全局不变量
tags: [overview, runtime, backend, zh]
---

# 系统总览

> **语言说明**：**简体中文** · [English (canonical)](./system-overview.md)。本页与英文主本同步；各子系统的深入实现细节见文末英文权威页。

CrewDesk（`my-agent-team`）是一套单机 Bun + SQLite 的 AI 工程团队控制面：它用**唯一一条 ACP（Agent Client Protocol）协议轨**统一驱动 `oma`、`claude`、`pi`、`omp` 四个 CLI 引擎，并把同一份产品事实实时同步给 Web 控制台、飞书机器人与浏览器内 Coding 工作区终端。

## 权威实现文件

- `apps/backend/src/main.ts` — 进程启动顺序与 `SIGTERM`/`SIGINT` 优雅排空
- `apps/backend/src/bootstrap/services.ts` — 进程级基础设施（`backend.db`、配置、MCP 客户端管理器、运行时观测库、飞书托管注册表）
- `apps/backend/src/bootstrap/features.ts` — 组合根：装配全部 22 组路由、ACP 后端、Product MCP 服务与后台循环
- `apps/backend/src/app.ts` — Elysia 路由挂载、全局 `authGuard` 与全局 `onError` JSON 契约
- `apps/backend/src/features/agent-run/execution-dispatch.ts` — 9 阶段 Run 派单状态机
- `apps/backend/src/features/agent-run/adapter-sqlite-enqueue.ts` — 原子 `enqueueAndAcquire` 事务
- `apps/backend/src/features/agent-run/adapter-sqlite-runs.ts` — 原子终态提交、`failCommit` 与下一输入晋升
- `apps/backend/src/features/agent-run/execution-service.ts` — 启动恢复 `recover()`、`steer`、审批回传、停止与关停
- `apps/backend/src/features/agent-run/acp/acp-backend.ts` — 驱动全部四个引擎的唯一 ACP 客户端
- `apps/oh-my-agent/src/core/runtime/create-runtime.ts` — 每次 Run 的 `oma` 运行时装配

## 容器与进程视图

```text
CrewDesk 控制面
───────────────────────────────────────────────────────────────────────────────
Web 控制台 (Next.js 15, :3001) ──HTTP BFF + /ws/ahp + /ws/coding──┐
                                                                  ├─→ Product Backend (Elysia, :3000)
飞书 Bot (每 PA 独立进程, SDK WS) ──HTTP + /ws/ahp────────────────┘     │
                                                                        ├── SQLite backend.db（32 张表）
                                                                        ├── 文件系统：workspaces/、projects/*.git、
                                                                        │            artifacts/、wiki/（Git）、skill-packs/、
                                                                        │            workflows/、mcp-servers.json
                                                                        ├── Coding 终端 (bun-pty)：shell 或 `oma` TUI
                                                                        └── 每次 Agent Run 启动 1 个一次性 ACP 子进程：
                                                                              ├─ oma     (oma --mode acp)
                                                                              ├─ claude  (claude-agent-acp)
                                                                              ├─ pi      (pi-acp)
                                                                              └─ omp     (omp acp)

独立 Oma CLI / TUI（无 Product Backend 依赖）
───────────────────────────────────────────────────────────────────────────────
用户终端 ──→ oma (tui / print / json) ──→ @chengchenccc/ai (直连模型 API) + 本地工作区 / JSONL 会话
```

- **Product Backend 之上的端（Surface）只有 Web 与飞书 Bot**：
  - **Web 端**不持后端 token，所有 API 经 `/api/bff/[...path]` 校验 `maw_session` 后在服务端注入 `x-auth-token`；实时更新全部走 `/ws/ahp` 与 `/ws/coding/:id`（60 秒一次性票据），后端已无活跃 SSE 端点。
  - **飞书 Bot**按 PA 成员独立运行（开发态由后端拉起，生产态由 `systemd` 模板 `my-agent-team-lark-bot@<agent>` 托管），直接对接飞书 OpenAPI 渲染 CardKit 流式卡片，经 `/ws/ahp` 订阅会话状态。
- **`oma`（`apps/oh-my-agent`）不是 Product Backend 的客户端端侧**：在 `tui` / `print` / `json` 模式下它是完全独立的自包含运行时，直接调用模型 API（`@chengchenccc/ai`）并读写本地工作区与 JSONL 会话文件；接入 CrewDesk 时只作为后端拉起的**子进程**存在——要么是按 Run 启动的 ACP 引擎（`oma --mode acp`），要么跑在 Coding 的 `bun-pty` 终端面板里。

## PA + Worker 团队协作模型

CrewDesk 在代码层（而非仅靠提示词）硬隔离两类 Agent 角色（ADR 0049、0072、0074）：

| 角色 | 职责 | 代码级硬边界 |
|---|---|---|
| **操作员（人）** | 持有配置变更权、批准不可逆或越界风险动作、最终合并与验收事项。 | Agent 发起的成员/项目/流程修改落进 `proposal` 表（「提议 ≠ 保存」）。 |
| **超级助理 PA（前台，`role !== "worker"`）** | 守住人的注意力：澄清意图、建/维护事项（Requirement）、按能力选人派单、凭证据回答 Worker 提问、维护共享 Git Wiki。 | `FRONT_DESK_DISABLED_TOOLS` 物理移除全部 14 个执行/文件/联网/扇出工具（`bash`、`eval`、`read`、`write`、`edit`、`ls`、`grep`、`glob`、`tree`、`web_search`、`web_fetch`、`browser`、`read_image`、`task`），无法绕过派单自己动手。 |
| **专职 Worker（`role === "worker"`）** | 在独立子会话（`parent_conversation_id`）和隔离的事项 Git worktree（`req/<requirementId>`）中执行开发、调研或评审。 | `agentConfigSchema` 禁止 worker 开启飞书；房间里人类发给 worker 的消息会自动重路由给前台（除非显式 `directToWorker: true`）；`project_push` 只允许推送到 `agent/<runId>`；未经第二名成员核验的改动会触发交付门提醒。 |

## 所有权划分

| 事实 / 能力 | 归属 | 说明 |
|---|---|---|
| 对话、账本、`AgentContext` 树与分支 | Product Backend（`backend.db`） | 全端共享真相源 |
| Agent Run、输入队列、`pending_action`、遥测、产品工具幂等账 | Product Backend（`backend.db`） | 执行控制面 |
| 事项、Proposal、提醒、环境规则台账、Artifact 与终端索引 | Product Backend（`backend.db`） | 跨工作面关联索引（ADR 0082） |
| Workflow 定义、执行、节点运行与人工任务 | Product Backend（`workflows/`、`backend.db`） | 纯域引擎在 `packages/workflow` |
| 共享 Wiki 与 Artifact 文件字节 | Product Backend（文件系统） | `<dataDir>/wiki`（Git）、`<dataDir>/artifacts` |
| Agent 身份、配置、技能与 MCP 目录 | 文件系统（后端幂等桥接） | `agent.yml`、`SOUL.md`、`USER.md`、`mcp-servers.json` |
| 子进程 transcript、工具循环、重试、compaction、原生 session | ACP 子进程自身 | 后端仅保存不透明的 `cli_session_ref` / `native_session_ref` |
| 端侧绑定、投递去重、卡片状态、UI 草稿 | 各自 Surface | 飞书维护 10 张本地 SQLite 表；Web 维护 React Query + AHP 状态镜像 |

## 唯一执行链

无论触发源是 Web、飞书、PA 派单、Workflow 节点、环境规则还是定时提醒，都会走同一条链路：

```text
输入（人 / 派单 / Workflow / 环境规则 / 提醒）
  1. 规范 MessageRevision 先落 conversation_ledger
  2. 触发路由（conversation_member 成员数 + ADR 0049 前台重路由 + ADR 0046 环境规则缝）
  3. enqueueAndAcquire（单 SQLite 事务：入队 + 活跃 Run 守卫 + 分支 CAS + 同步最新 20 条 + 建 agent_run）
  4. 9 阶段派单状态机（execution-dispatch.ts）：
       load_run → budget_gate → model_preflight → claim_input
       → resolve_workspace → set_product_tools → context_projection
       → backend_execute → settle_outcome → acquire_next
  5. AcpBackend 按 Run spawn 一个一次性子进程（stdio JSON-RPC）
  6. 实时事件扇出到 AhpChatWriter（/ws/ahp）、遥测白名单与持久化 pending_action
  7. 子进程收敛为唯一终态 BackendRunOutcome（completed | failed | aborted | timeout）
  8. 原子 commitCompletedRun 事务（账本 + Context 引用 + 分支 CAS + Run 状态 CAS）
  9. 晋升分支上下一条排队输入（acquireNextRun），若为派单则回传通知父 Run
```

设置 `OMA_DEBUG=1` 可在 stderr 输出每个具名派单阶段，用于快速定位卡点。

## 失败原则

| 失败位置 | 系统行为 |
|---|---|
| 接收前失败（日预算、模型预检、工作区、spawn、握手） | Run 置 `failed`，绑定输入置 `cancelled`，写入错误消息（`run:<runId>:error`），通知订阅者。 |
| 子进程在产出结果前退出 | 用退出码 + stderr 尾部合成 `failed`（若后端正在关停 `isBackendShuttingDown()`，则落 `aborted`）。 |
| 协议违例或命令超时 | Run 置 `failed`，杀掉子进程（`SIGTERM` → 3s → `SIGKILL`）。 |
| 静默看门狗（默认 90s）或墙钟上限（默认 30m） | 存在进行中工具调用或未决 `pending_action` 时自动豁免；否则 `backend.stop(runId)` → `aborted`。 |
| 终态提交写库失败 | `failCommit` 将 Run 置 `commit_failed` 并保存 `terminal_result`；分支继续占用，重启 `recover()` 直接重试提交而不重跑子进程。 |
| 实时推送 / WebSocket 订阅异常 | 内部吞掉，绝不影响 Run 执行与结算。 |
| 后端崩溃或重启 | 启动 `recover()` 重投 `delivering` 输入、晋升空闲分支队列、重试 `commit_failed`、补发未送达的工人回传、保留停靠在未决 HITL 的 `waiting` Run（ADR 0038），并中止已失联的孤儿 Run。 |

## 全局不变量

1. **人类消息先落账本，再取 Run**：两者分属不同事务，入队失败时消息仍留在账本中。
2. **同一分支同时只有一个活跃 Run**（`running | waiting | commit_failed`），由 SQLite 部分唯一索引 `idx_agent_run_active_branch` 与应用层事务双重保障。
3. **终态 `BackendRunOutcome` 是唯一权威**：流式增量永不进入 `conversation_ledger`。
4. **每次 Run 的配置快照不可变**：模型、系统提示、技能根、权限模式、工具策略、授权依据、父 Run 与风险声明在入队/取 Run 时一次性冻结。
5. **产品工具 Token 按次签发、仅走环境变量**：启动前铸造，仅经 `PRODUCT_TOOLS_RUN_TOKEN` 传入子进程，内存只存 SHA-256 哈希，在 `finally` 中必吊销。
6. **共享工作区由锁串行**：共享事项副本（`shared !== false`）持锁直到 Run 结算；独立工作区（`shared: false`）在准备完成后即释锁。

## 延伸阅读（英文权威规范）

- [Data Model](./data-model.md) — 32 张 SQLite 表与事务边界
- [Agent Run Execution](./agent-run-execution.md) — 9 阶段派单机、HITL 停靠与重启恢复
- [ACP Backend Contract](./acp-backend-contract.md) — 5 个契约方法与 4 个引擎的 ACP 接入
- [Team Coordination](./team-coordination.md) — PA + Worker 协作、Product MCP 与派单闭环
- [Operations & Gateway](./operations-and-gateway.md) — DI 组合根、`oma gateway` 与排障手册
