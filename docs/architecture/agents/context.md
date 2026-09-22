---
title: Agent Context
description: 树/分支/条目的作用域、取 Run 时的同步与投影、分支 revision CAS 与 CLI session 续接，以及哪些能力有代码但没有调用方
tags: [context, history, backend]
---

# Agent Context

Agent Context 是某个 Agent 实际消费和保留的语义历史。每个对话一棵树、一条默认分支，分支里是一串指向账本的引用；每次派单都从这棵树重新投影出一份历史。

## 范围

覆盖：树/分支/条目的存储与作用域、取 Run 时的同步、投影产物、CLI session 续接、分支 revision CAS 与种类切换时的分叉、显式 retain 追加路径，以及一份「写好了但没人用」的清单。

不覆盖：账本本身（见 [Conversation History](../conversation/history.md)）、Run 与队列协议（见 [Run 输出与实时更新](../runs/output-and-live-updates.md)）、子进程内部的 compaction（见 [Compaction](../runtime/compaction.md)）。

## 实现文件

- `apps/backend/src/features/agent-context/domain.ts` — 条目联合类型、`ContextBranch`、`validateEntry`、revision 冲突错误
- `apps/backend/src/features/agent-context/service.ts` — 服务面
- `apps/backend/src/features/agent-context/adapter-sqlite.ts` — 树/分支的创建、`listEntriesToLeaf`、`appendEntry`（CAS）、`forkBranch`、`moveBranchLeaf`、`updateBranchCliSessionRef`
- `apps/backend/src/features/agent-context/projection.ts` — `projectAgentContext`，唯一在生产路径上被调用的部分
- `apps/backend/src/features/agent-run/adapter-sqlite-enqueue.ts` — 真正的「把 History 同步进 Context」那一步
- `apps/backend/src/features/agent-run/execution-dispatch.ts` — 投影调用与 `cliSessionRef` 处理
- `apps/backend/src/features/agent-run/execution-input.ts` — 首轮的历史桥接与续接判定
- `apps/backend/src/features/product-tools/service.ts` — `history_retain` 追加引用

## 作用域是对话

树由 `idx_context_tree_conversation` 保证每个对话一棵，没有按成员的维度。

条目类型声明了五种：`ledger_message | private_message | product_tool_exchange | summary | model_change`。

**生产里只写 `ledger_message` 一种。** 写入方分别是取 Run 时的同步、终态提交、`history_retain`，以及通用的 `appendEntry`（只有测试在调）。

## 取 Run 时同步什么

同步条件是 `ledger_seq > ledger_cursor`、未 undone、`kind = 'message'`、`visibility != 'internal'`，取**最后 20 条**，按顺序追加，然后把 `ledger_cursor` 推到扫过的最后一条，并把 `leaf_entry_id` 移过去。

## 投影

`projectAgentContext` 从根走到叶，把引用解析成历史条目：

- 遇到 summary 条目就替代它覆盖的那些条目；
- 账本引用要经 resolver 解析，引用缺失即抛错；
- summary 与 product_tool_exchange 生成 `visibility: "internal"` 的消息；
- `model_change` 不产生历史条目。

每次派单调用一次。这条路径的前提就是「每次 Run 都从完整投影重建」，不做增量续接。

## 生效模型

生效模型在取 Run 的事务里算出来：从叶子往根找最后一条 `model_change`。`resolveEffectiveModel` 这个方法只有测试在用。

## 分支与后端种类

分支的 `backend_kind` 在建分支时就钉住。Agent 的种类变了以后，取 Run 时会分叉出一条新的默认分支（或者把空分支重新钉种类）并把树指过去。每棵树只有一个默认分支，由数据库唯一索引保证。

**CLI session 续接是分支上的一等事实**：Run 结束后，`cli_session_ref` 带种类前缀存到分支上；下次 spawn 前剥回原始引用交给子进程；子进程用它加载自己的 session transcript 作为本次 Run 的种子历史。首轮那条扁平文本历史桥，只在**没有** `cli_session_ref` 时才用。

也就是说：产品侧没有会话概念，但运行侧确实在续接，续接的载体是分支上的这个引用（见 [ADR 0019](../../adr/0019-cli-session-dual-truth.md)）。

## 显式追加

`history_retain` 是唯一一条「显式把东西加进 Context」的路：先校验消息存在且可见，然后在同一个事务里追加一条 `ledger_message` 引用和对应的产品工具调用行。只读工具什么都不加。

## 并发

`appendEntry`、`forkBranch`、`moveBranchLeaf` 都带 `expectedRevision`，不匹配抛 `ContextRevisionConflictError`；取 Run 时也会 CAS 一次分支 revision。

## 写好了但没有调用方

下面这些能力在代码里存在、有测试，但没有任何产品路径能到达：

- **分叉与回滚**：`forkBranch` 唯一的非测试调用方是后端种类切换；`moveBranchLeaf` 只有测试在调。仓库里没有任何 `/api/...branch|context` 路由，也没有对应 UI。
- **summary**：`appendSummary` 没有调用方，投影里的 summary 分支在生产不可达；对话的 `/compact` 与 `/clear` 都是显式空操作。
- **`private_message` 与 `product_tool_exchange` 条目**：没有写入方。
- **`model_change` 条目**：没有写入方（生效模型是另算的）。
- **`resolveEffectiveModel`**：只有测试调用。

## 不变量

1. 每个对话一棵 Context 树，每棵树一个默认分支。
2. Context 只存引用与派生条目，消息事实在账本里。
3. 每次派单从完整投影重建，不做增量续接；续接发生在 CLI session 层。
4. 所有条目写入与分支移动都过 revision CAS。
5. 只有 `kind = "message"` 且非 internal 的账本行会进 Context。
6. 未被触发的 Agent 不消费消息。
