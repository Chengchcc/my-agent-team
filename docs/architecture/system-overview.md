---
title: 系统总览
description: 一次 Agent Run 从输入到终态提交的权威链路：执行链阶段、四方所有权划分、容器视图与失败原则
tags: [runtime, backend]
---

# 系统总览

本页是一次 Agent Run 从输入到终态提交的权威描述：谁拥有什么事实、执行链上有哪些阶段、每次执行各自负责什么。

## 范围

覆盖：唯一执行链与它的阶段、四方（Product / 子进程 / Adapter / Workflow）的所有权划分、容器视图、稳定概念、主流程、失败原则。

不覆盖：各个 id 的归属与生成规则（见 [标识符体系](./foundations/identifiers.md)）、历史与上下文的数据语义（见 [事实与投影](./foundations/facts-and-projections.md)、[Agent Context](./agents/context.md)）、各后端的 spawn 细节（见 [Agent Backend](./execution/agent-backend.md)）、Workflow 节点语义（见 [Agentic Workflow](./workflow.md)）。

## 实现文件

- `apps/backend/src/features/agent-run/execution-dispatch.ts` — 派单阶段机：预检 → 认领输入 → 解析工作区 → 产品工具清单 → 投影 → 执行 → 结算 → 晋升下一个
- `apps/backend/src/features/agent-run/adapter-sqlite-enqueue.ts` — 入队与取 Run（一个事务）
- `apps/backend/src/features/agent-run/adapter-sqlite-runs.ts` — 终态提交、失败提交、下一 Run 晋升
- `apps/backend/src/features/agent-run/execution-service.ts` — steer、恢复、提交重试、审批、停止
- `apps/backend/src/features/agent-context/projection.ts` — 分支投影
- `apps/backend/src/features/product-tools/{manifest,mcp,run-token-registry}.ts` — 产品工具 MCP 与每次 Run 的 token
- `apps/backend/src/bootstrap/features.ts` — 组装点：后端注册表与 execution 依赖
- `packages/agent-contract/src/{backend,run,kinds}.ts` — 执行协议、终态契约、后端种类
- `packages/adapter-{oma,claude,pi,omp}-agent/src/backend.ts` — 四个 Adapter
- `apps/oh-my-agent/src/core/runtime/create-runtime.ts` — 每次 Run 的 Oma Runtime 装配

## 容器视图

```text
Web (Next.js, :3001) ─┐
                      ├─ HTTP/SSE ─→ Product Backend (Elysia, :3000)
Lark bot ─────────────┘                    │
                                           │ 每个 Run spawn 一个子进程
                                           ├─→ oma     (stdin/stdout JSONL RPC)
                                           ├─→ claude  (stream-json)
                                           ├─→ pi      (json)
                                           └─→ omp     (json)
                                           │
                                           └─ SQLite backend.db（产品事实 + 执行控制面）
```

Web 不直连后端数据，走 BFF 代理并带上服务端 token（见 [Web 端](./surfaces/web.md)）。

## 谁拥有什么

| 事实 | 归属 |
|---|---|
| 对话、账本、Agent Context | Product Backend |
| Agent Run 与输入队列、产品工具调用账 | Product Backend |
| Project、技能包、知识库、设置 | Product Backend |
| Workflow execution 与节点运行 | Product Backend |
| Artifact 文件 | Product Backend 的文件系统 |
| 子进程的 transcript、工具循环、重试、compaction | 子进程自己 |
| 原生 session | 子进程自己；产品只存一个引用 |

产品只依赖 `AgentBackend` 协议，不读子进程的 transcript，也不依赖它内部的 todo、compact、重试策略。

后端的种类注册表是 `oma` / `claude_code` / `pi` / `omp`。注册表是部分的：未知种类在预检阶段返回 422，走不到 spawn。

## 唯一执行链

```text
输入（人 / Workflow 节点 / cron 触发的 Workflow）
→ Conversation History 落账
→ 触发判定与模式路由
→ 取 Run（一个事务：入队、活跃 Run 守卫、分支 CAS、Context 引用、建 Run）
→ 派单（预检模型 → 认领输入 → 解析工作区 → 写产品工具清单 → 投影历史）
→ Agent Backend spawn 一个子进程
→ transient 事件流 fan-out 到订阅者
→ 终态 BackendRunOutcome
→ 原子提交（账本 + Context 引用 + 分支 CAS + Run CAS）
→ 晋升下一个排队的输入
```

派单阶段的具名阶段是：`load_run`、`model_preflight`、`claim_input`、`resolve_workspace`、`set_product_tools`、`context_projection`、`backend_execute`、`settle_outcome`、`acquire_next`。它们会带 `OMA_DEBUG=1` 输出到 stderr，用于排查卡在哪一步。

## 一次 Run 的主流程

**入队。** 人类消息先落账本，随后创建 Run。两者不在同一个事务里，所以「消息在、Run 没建起来」是一种真实存在的中断。

**取 Run** 是一个 immediate transaction，里面有：插队列行、活跃 Run 守卫、无活 Run 的 steer 取消、作用域校验、分支 revision CAS、读游标之后未 undone 的账本行、可见性过滤、取最后 20 条、追加 Context 引用、推进游标与叶子、回溯生效模型、建 `agent_run` 行、把输入置为 `delivering`。

**执行。** 预检按 `model_ref.backendKind` 查注册表；spawn 之前用数据库真相源重写工作区桥接文件；同一个 worktree 上的 Run 经 workspace lock 串行；spawn 槽位按 `maxConcurrent` FIFO。输入只有被适配器接收后才 CAS 成 `delivered`。

**steer 只对 oma 有效。** 没有活句柄时显式失败并取消输入，绝不重放或降级。CLI 类后端显式 steer 会在产品层改写成 `normal`。

**终态。** completed 走一次事务提交；failed / aborted / timeout 则广播状态、落一条用户可见的错误消息、写终态。

**取消。** `POST /api/agent-runs/:runId/cancel`，已终态返回 `already_terminal`；活跃的才 `stop()`——有活子进程就 abort，僵尸则直接终态化并晋升下一个。

**超时。** 每个 Run 有墙钟上限，默认 30 分钟，到点让 backend `stop()`，Run 落 aborted。

**重启恢复。** `AgentRunExecutionService.recover()` 处理四类：`delivering` 输入按原 runId 重投、崩溃缺口把空闲分支上的 pending 输入晋升成新 Run、`commit_failed` 逐个重试提交（只用已存的 outcome，不重跑后端）、已投递但没有活子进程的孤儿置 aborted 并晋升下一个。

> 注意：`recover()` 目前**没有生产调用方**（启动时只跑了 workflow 的 `recover()`）。四类恢复逻辑都在代码里，但线上不会被调起，详见 [Product Backend 总览](./backend/overview.md#已知缺口)。

**收尾。** dispatch 的 finally 统一清 live 句柄、吊销产品工具 token、关闭订阅者；进程退出时先杀所有子进程再排空在飞的 dispatch。

## 稳定概念

| 概念 | 说明 |
|---|---|
| Agent Run | 唯一的执行身份，对应一个子进程 |
| BackendRunOutcome | 唯一的终态依据，completed / failed / aborted / timeout |
| Conversation History | 共享的对话事实，账本 |
| Agent Context | 某个 Agent 消费与保留的语义历史，存引用 |
| Context Branch | 可 fork 的历史路径，Run 都挂在某个分支上 |
| Workspace | Run 的工作目录：agent 工作区，或绑定了 Project 时的 worktree |
| Product Tool | 由产品执行的能力，经 MCP 暴露、带每次 Run 独立的 token |

**没有的东西**：跨 Run 的常驻进程、产品侧的会话或 checkpointer。运行侧确实在续接——载体是分支上的 `cli_session_ref`（带上后端种类前缀），由各后端用自己的原生 session 机制加载，产品只存引用、只转发，从不解析。见 [Agent Context](./agents/context.md) 与 [ADR 0019](./../adr/0019-cli-session-dual-truth.md)。

## 失败原则

| 失败点 | 结果 |
|---|---|
| 接收前的失败（模型预检、投影、工作区、spawn、适配器接收） | Run 落 failed，输入取消，订阅关闭 |
| 子进程在给结果前崩溃 | 用退出码与 stderr 尾部合成 failed 结果 |
| stdout 协议损坏 | `failProtocol`，Run failed |
| 终态提交失败 | Run 落 `commit_failed`，分支继续被占用 |
| 实时推送失败 | 不影响 Run：订阅者异常与流关闭都被吞掉 |
| 节点/工具内部错误 | 子进程自己处理，通过 outcome 或事件表达 |

## 不变量

1. Run 是唯一的执行身份，每个 Run 对应一个一次性子进程。
2. 同一个分支同时只有一个活跃 Run。
3. 终态 outcome 是唯一权威，它之前的一切都只是 transient。
4. 流式输出永不进产品事实。
5. 人类消息先落账本再创建 Run；终态提交才把 Agent 消息与 Context 引用写进产品事实。
6. 输入被适配器接受后才算投递成功。
7. 子进程的内部机制（重试、compaction、todo、技能加载）不被产品依赖。
8. 产品工具权限归产品，每次 Run 一个 token，只在 spawn env 里传递，终态必吊销。
