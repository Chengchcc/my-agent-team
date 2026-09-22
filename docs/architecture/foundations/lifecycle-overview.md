---
title: 生命周期总览
description: 一次 Run 从触发到终态的全程：取 Run、终态提交、取消与超时、重启恢复的实际可达性
tags: [runs, backend]
---

# 生命周期总览

本页描述一次 Agent Run 从触发到终态的全过程，包括取消、超时与重启恢复。

## 范围

覆盖：触发来源、入队与取 Run、执行与停靠、终态提交、收尾、状态表、以及失败时往哪走。

不覆盖：派单内部每个阶段的实现细节（见 [Agent Backend](./../execution/agent-backend.md)）、历史与上下文的数据语义（见 [事实与投影](./facts-and-projections.md)）、Workflow 图本身（见 [Agentic Workflow](./../workflow.md)）。

## 实现文件

- `apps/backend/src/features/agent-run/execution-dispatch.ts` — 派单阶段机与 follow-up 链
- `apps/backend/src/features/agent-run/execution-service.ts` — steer、恢复、提交重试、停止
- `apps/backend/src/features/agent-run/adapter-sqlite-{enqueue,runs,inputs,actions}.ts` — 队列、提交、输入查询
- `apps/backend/src/features/agent-run/http.ts` — 取消、审批、事件流端点
- `apps/backend/src/features/conversation/service.ts` — 触发与模式自动路由
- `apps/backend/src/features/workflow/service.ts` — Workflow 的 agent 节点如何产生一次普通 Run
- `packages/adapter-{oma,claude,pi,omp}-agent/src/backend.ts` — spawn、接收、steer、停止

## 触发来源

只有三种，最终都走同一条 `postMessage` → 取 Run 的路：

- 人发消息；
- Workflow 的 agent 节点（它的 conversationId 形如 `workflow:<executionId>:<nodeId>`）；
- Workflow 的 cron 触发。

## 入队与取 Run

入队时就把这次执行的配置快照定下来：系统提示、技能根、权限模式在取 Run 时解析并落到 `agent_run` 与队列行上；派单阶段从不重新解析，保证一次 Run 用一个版本的配置。

取 Run 的原子性见 [Product Backend 总览](./../backend/overview.md#取-run-是一个事务)。

## 执行与停靠

预检查注册表（未知种类 422），spawn 前重写工作区桥接，同一 worktree 上的 Run 串行。

**steer 只对活着的 Run 有效**：没有活句柄就显式失败并取消输入，绝不重放或降级；CLI 类后端在产品层就把 steer 改写成 `normal`。

## 状态与走向

| 状态 | 什么时候 | 谁能把它推进 |
|---|---|---|
| `running` | 接受输入之后 | 子进程给 outcome，或 watchdog、取消 |
| `waiting` | 枚举里有，**当前没有生产者** | — |
| `completed` | 子进程给出成功终态 | 终态提交事务 |
| `failed` | 预检/投影/spawn 失败，子进程崩溃，协议损坏 | 终态提交 |
| `aborted` | 用户取消、超时、僵尸清理 | 终态提交 |
| `commit_failed` | 终态提交事务失败 | 重试提交（**当前线上不可达**） |

`waiting` 之所以没有生产者：唯一会写它的路径需要一个待响应事项的持久化记录，而那条路径没有任何生产调用方。真实的审批走 Run 级 SSE 加审批端点，Run 全程保持 `running`。

## 终态提交

completed 走一次事务：账本行、Context 引用、分支 CAS、Run CAS。失败、中止、超时则广播状态、落一条用户可见的错误消息、写终态；只有 canonical 提交才写账本里的 assistant 消息，错误气泡是另一回事。

**提交失败的分支会被永久占住**：`commit_failed` 算活跃状态，而唯一的重试入口只从「没被调起的恢复函数」里可达。

## 取消、超时与恢复

**取消**：`POST /api/agent-runs/:runId/cancel`。已终态返回 `already_terminal`，活跃的才 `stop()`；有活子进程就让子进程 abort，僵尸则直接终态化并晋升下一个排队输入。

**超时**：watchdog 按 `runTimeoutMs`（默认 30 分钟）到点调 `backend.stop()`，Run 落 aborted。

**重启恢复** 分四类：`delivering` 的输入按原 runId 重投（适配器幂等）；崩溃缺口把空闲分支上没有 runId 的 pending 输入晋升成新 Run，用它自己的配置快照；`commit_failed` 逐个重试提交（只用已存的 outcome）；已投递但没有活子进程的孤儿置 aborted 并晋升下一个。

这四类都写在 `recover()` 里，**但启动时没有人调它**——目前只有 Workflow 的 `recover()` 被调起。进程重启后，之前的状态会一直躺着，直到那个对话来了新消息才触发僵尸清理。

## 收尾

派单的 finally 里统一清理：删掉 live 句柄、吊销产品工具 token、关闭订阅者。进程退出时先杀所有子进程，再排空在飞的派单。

## follow-up

当前 Run 结算之后（不管成功、失败还是中止），队列里最老的、非 steer 的输入会被晋升成一个**新 Run**，用输入自己那份配置快照。

## 事件流

`GET /api/agent-runs/:runId/events` 对终态 Run 只发一个状态事件；`commit_failed` 报 failed 但不动 Run；正在派单的 Run 不会被 abort；真僵尸先终态化再报 aborted。细节见 [Run 输出与实时更新](./../runs/output-and-live-updates.md)。

## 不变量

1. 一次 Run 一个子进程，一个终态。
2. 配置快照在入队时冻结，派单不重新解析。
3. 输入被适配器接受后才算投递成功。
4. steer 不重放：没有活 Run 就取消输入。
5. follow-up 造的是新 Run，不是复用旧 Run。
6. 终态提交是唯一把 Agent 消息变成产品事实的路径。
