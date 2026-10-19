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
- `apps/backend/src/features/agent-context/adapter-sqlite.ts` — 树/分支的创建、`listEntriesToLeaf`、`appendEntry`（CAS）、`forkBranch`、`updateBranchCliSessionRef`
- `apps/backend/src/features/agent-context/projection.ts` — `projectAgentContext`，唯一在生产路径上被调用的部分
- `apps/backend/src/features/agent-run/adapter-sqlite-enqueue.ts` — 真正的「把 History 同步进 Context」那一步
- `apps/backend/src/features/agent-run/execution-dispatch.ts` — 投影调用与 `cliSessionRef` 处理
- `apps/backend/src/features/agent-run/execution-input.ts` — 首轮的历史桥接与续接判定
- `apps/backend/src/features/product-tools/service.ts` — `history_retain` 追加引用

## 作用域是对话

树按 `(conversation, agent)` 唯一（ADR 0041 的成员模型）：`idx_context_tree_conversation_agent` 建在 `(conversationId, agentId)` 上，所以一个对话里每个成员 agent 各有一棵自己的树。

条目类型只有两种：`ledger_message | summary`。（另外三种——`private_message`、`product_tool_exchange`、`model_change`——从来没有写入方，2026-10-19 连同端口、服务、适配器与测试一起删掉了。换模型的产品入口是会话输入框上的 `ModelPicker`，它是可见的；分支级隐形 pin 与「换模型必须可见」的规矩冲突。）

**生产里写两种：`ledger_message` 与 `summary`。** `ledger_message` 的写入方是取 Run 时的同步、终态提交与 `history_retain`；`summary` 由 `/compact` 产生（`compactConversation` → `appendSummary` → `port.appendEntry`）。

## 取 Run 时同步什么

同步条件是 `ledger_seq > ledger_cursor`、未 undone、`kind = 'message'`、`visibility != 'internal'`，取**最后 20 条**，按顺序追加，然后把 `ledger_cursor` 推到扫过的最后一条，并把 `leaf_entry_id` 移过去。

## 投影

`projectAgentContext` 从根走到叶，把引用解析成历史条目：

- 遇到 summary 条目就替代它覆盖的那些条目；
- 账本引用要经 resolver 解析，引用缺失即抛错；
- summary 生成 `visibility: "internal"` 的消息。

每次派单调用一次。这条路径的前提就是「每次 Run 都从完整投影重建」，不做增量续接。

## 生效模型

生效模型就是调用方解析出来的那个：agent 配置，或者会话输入框里显式选的覆盖（`model` 字段）。取 Run 不再沿分支向上找任何东西——分支上没有模型状态。

## 分支与后端种类

分支的 `backend_kind` 在建分支时就钉住。Agent 的种类变了以后，取 Run 时会分叉出一条新的默认分支（或者把空分支重新钉种类）并把树指过去。每棵树只有一个默认分支，由数据库唯一索引保证。

**CLI session 续接是分支上的一等事实**：Run 结束后，`cli_session_ref` 带种类前缀存到分支上；下次 spawn 前剥回原始引用交给子进程；子进程用它加载自己的 session transcript 作为本次 Run 的种子历史。首轮那条扁平文本历史桥，只在**没有** `cli_session_ref` 时才用。

也就是说：产品侧没有会话概念，但运行侧确实在续接，续接的载体是分支上的这个引用（见 [ADR 0019](../../adr/0019-cli-session-dual-truth.md)）。

## 显式追加

`history_retain` 是唯一一条「显式把东西加进 Context」的路：先校验消息存在且可见，然后在同一个事务里追加一条 `ledger_message` 引用和对应的产品工具调用行。只读工具什么都不加。

## 并发

`appendEntry`、`forkBranch` 都带 `expectedRevision`，不匹配抛 `ContextRevisionConflictError`；取 Run 时也会 CAS 一次分支 revision。

## 写好了但没有调用方

下面这些能力在代码里存在、有测试，但没有任何产品路径能到达：

- **`forkBranch`**：唯一的非测试调用方是后端种类切换（agent 换 kind 时把新分支钉成默认）。它不需要产品入口。
- ~~**硬回退**~~（2026-10-16 删除）：`moveBranchLeaf` 是零调用方的原语（只有测试在调）。产品侧的问法已经由另外两条路回答了——`/api/conversations/:id/undo` 是墓碑式软撤销（账本项标 `undone` + 追加一条 `undo` 项），`/fork` 与 `/replay` 是新建会话。留一条没人调的硬回退等于投机性灵活，故连端口、服务、适配器与测试一起删掉；将来真要「原地回到某点」（比如 replay 不再新建会话）再写回来很便宜。

## 不变量

1. 每个对话一棵 Context 树，每棵树一个默认分支。
2. Context 只存引用与派生条目，消息事实在账本里。
3. 每次派单从完整投影重建，不做增量续接；续接发生在 CLI session 层。
4. 所有条目写入与分支移动都过 revision CAS。
5. 只有 `kind = "message"` 且非 internal 的账本行会进 Context。
6. 未被触发的 Agent 不消费消息。
