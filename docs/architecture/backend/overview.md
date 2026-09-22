---
title: Product Backend 总览
description: 后端拥有哪些产品事实、取 Run 的那个事务、输入模式路由、终态提交与失败原则；查执行链归属和 Run 生命周期时打开
tags: [backend, runs, data]
---

# Product Backend 总览

Product Backend 拥有全部产品事实和执行控制面。执行链只有一条：Agent Run → Agent Backend → 一次性子进程。

## 范围

覆盖：所有权划分、取 Run 的那一个事务、输入模式路由、终态提交、失败原则、每个 Run 的产品工具 token、工作区解析、上限与串行化、实时更新的边界。

不覆盖：逐表 schema（见 [数据模型](./data-model.md)）、账本细节（见 [Conversation History](../conversation/history.md)）、Context 投影（见 [Agent Context](../agents/context.md)）、Run 的事件清单（见 [Run 输出与实时更新](../runs/output-and-live-updates.md)）。

## 实现文件

- `apps/backend/src/bootstrap/features.ts` — 组装点：backend 注册表、execution 依赖、`start()`
- `apps/backend/src/features/agent-run/service.ts` — 对产品的 Run 服务：取 Run、待响应事件透传
- `apps/backend/src/features/agent-run/{execution,execution-service,execution-dispatch,execution-live,execution-input}.ts` — 派单、实时扇出、输入组装
- `apps/backend/src/features/agent-run/adapter-sqlite*.ts` — 持久侧，事务都在这里
- `apps/backend/src/features/conversation/{service,http}.ts` — 历史与触发
- `apps/backend/src/features/{agent-context,workflow,artifact,product-tools}/` — 各能力域

## 拥有什么

产品事实：对话与账本、Agent Context、Project、技能包与知识库、设置。

执行控制面：Agent Run 与输入队列、产品工具调用账、Run 遥测。

子进程拥有的：它自己的 transcript、工具循环、重试、compaction、todo、技能加载。产品只依赖 `AgentBackend` 协议，不依赖这些内部机制。

后端种类的注册表是 `oma` / `claude_code` / `pi` / `omp`。注册表是部分的，未知种类在预检阶段就返回 422，不会走到 spawn。

## 取 Run 是一个事务

`enqueueAndAcquire` 是唯一的 Run 创建入口，整段在一个事务里：

1. 插队列行；
2. 按 `input_key` 检查是否重放；
3. 活跃 Run 守卫（同一分支只允许一个）；
4. 无活跃 Run 的 steer 直接取消；
5. 校验分支、对话、种类的作用域；
6. **分支 revision CAS**；
7. 读 `ledger_cursor` 之后、未 undone 的账本；
8. 过滤可见性（`kind = 'message'` 且 `visibility != 'internal'`）；
9. 取**最后 20 条**，按顺序追加 Context 引用；
10. 推进 `ledgerCursor` 与 `leafEntryId`；
11. 从叶子往根找最后的 `model_change`，定出本次生效的模型；
12. 插 `agent_run` 行，输入转 `delivering` 并绑上 runId。

第 9 步的「最后 20 条」是硬编码，不是可配置的预算。

## 输入模式

`steer` 只对 oma 有意义，CLI 类后端没有中途注入，所以显式 steer 到非 oma 会改写成 `normal`。

自动模式按当前状态选：有活着的子进程 → `steer`；正在派单 → `follow_up`；数据库里显示活跃但两者都不在（僵尸）→ 先 abort 掉再按 `normal` 处理。

steer 从不重放：没有活跃 Run 时它会被取消，注入时拿不到活句柄也会取消。

`follow_up` 在当前 Run 结束后被晋升成一个**全新 Run**，用的是它自己那份配置快照。

## 终态提交

完成的 Run 在一个事务里提交：规范化消息序列 → 按 `(agent_run_id, message_index)` 逐条插账本（冲突即忽略，再回读 seq）→ 按 `(tree_id, ledger_seq)` 去重后追加 Context 引用 → 一次分支 CAS → 一次 Run 状态 CAS。

提交失败走 `failCommit`：Run 变 `commit_failed`，分支继续被占用。

## 失败原则

- 接收前的失败（模型预检、投影、工作区、spawn、适配器接收）→ Run failed，输入取消。
- 子进程在给结果前崩掉 → 用进程退出码加 stderr 尾部合成 failed 结果。
- stdout 协议损坏 → `failProtocol`，Run failed。
- 实时推送失败**不影响 Run**：订阅者出错与流关闭都被吞掉。
- 失败的 Run 也会落一条用户可见的错误消息（`run:<runId>:error`）。

## 每个 Run 的产品工具 token

spawn 之前铸造，只经 spawn env 送达子进程（wire 载荷里会被剥掉），任何终态路径上都吊销。产品工具清单在 `execute` 之前就持久化好——MCP 侧要靠它校验，而且是一次写入。

## 工作区

Run 自己 pin 的工作区优先，否则由 `resolveWorkspace` 决定（见 [Project 与 Worktree](../agents/projects-and-worktrees.md)）。同一个 worktree 上的 Run 经 workspace lock 串行。spawn 之前会用数据库真相源重写一遍桥接文件。

## 上限与串行化

- 每次 Run 有墙钟上限，默认 30 分钟，到点让 backend `stop()`，Run 落 aborted。
- 适配器自己还有一个 spawn 槽位的 FIFO 上限（`maxConcurrent`）。
- 同一个 worktree 的 Run 串行。

## 实时更新

只有 transient 扇出：广播给进程内订阅者，并按白名单尽力落遥测。SSE 端点是 `GET /api/agent-runs/:runId/events`，事件名就是 `ev.type` 原文。晚订阅的语义见 [Run 输出与实时更新](../runs/output-and-live-updates.md)。

## 不变量

1. Run 是唯一的执行身份；每个 Run 对应一个一次性子进程。
2. 同一分支同时只有一个活跃 Run，应用层与数据库索引双重强制。
3. 人类消息先落账本，再创建 Run；两者不在同一个事务里。
4. 终态提交四件事同事务，提交身份是 `(agent_run_id, message_index)`。
5. 产品工具 token 每次 Run 独立，只经 env 送达，终态必吊销。
6. 流式输出永远不进产品事实。

## 已知缺口

- `AgentRunExecutionService.recover()` **没有生产调用方**：启动时只跑了 workflow 的 `recover()`。进程重启后，`delivering` 的输入与活跃 Run 会一直躺着，直到该对话来了新消息才触发 `abortStaleRun`。
- 同样因为没有调用方，`retryTerminalCommit` 在线上不可达；而 `commit_failed` 又算活跃状态，于是提交失败会把那个分支**永久占住**。
- `agent_run.status` 里的 `waiting` 没有生产写入方（`pending_action` 无人写）。
- Context 的 `summary` 条目没有生产者，投影里的 summary 分支在生产路径上不可达。

详细清单见 [`../../roadmap.md`](../../roadmap.md)。
