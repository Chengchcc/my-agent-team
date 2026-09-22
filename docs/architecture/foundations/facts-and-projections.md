---
title: 事实与投影
description: 哪些数据是产品事实、哪些只是执行缓存或投影，以及一个 Message 什么时候才算真的发生
tags: [context, history, runs]
---

# 事实与投影

本页说明哪些数据是产品事实、哪些只是执行缓存或投影，以及一个 Message 什么时候才算真的发生了。

## 范围

覆盖：Message 的本体、三类状态、事实与投影的分工、人的消息与 Agent 的消息各自何时成为事实、产品工具的结果怎么进 Context、产品摘要与子进程 compaction 的区别、为什么每次都重建投影。

不覆盖：表结构（见 [数据模型](./../backend/data-model.md)）、id 的归属（见 [标识符体系](./identifiers.md)）、History 与 Context 的读写 API（见 [Conversation History](./../conversation/history.md)、[Agent Context](./../agents/context.md)）。

## 实现文件

- `packages/message/src/index.ts` — Message / MessageRevision 的唯一本体与序列化
- `apps/backend/src/features/conversation/service.ts` — 账本写入（`serializeMessageRevision`）
- `apps/backend/src/features/agent-run/adapter-sqlite-enqueue.ts` — 取 Run 时把账本同步成 Context 引用
- `apps/backend/src/features/agent-run/adapter-sqlite-runs.ts` — 终态提交：账本 + 引用同事务
- `apps/backend/src/features/agent-context/projection.ts` — 唯一的分支投影实现
- `apps/backend/src/features/agent-run/execution-input.ts` — 首轮的扁平历史桥
- `apps/backend/src/features/product-tools/service.ts` — `history_retain`，唯一能显式往 Context 加东西的产品工具
- `apps/oh-my-agent/src/core/runtime/create-runtime.ts` — 子进程内部的 compaction 与 context 用量

## Message 只有一个本体

`Message` 是唯一的领域类型，由 `@chengchenccc/message` 定义。账本里存的是 `serializeMessageRevision(revision)`，终态提交走的也是同一条序列化路径。Web、飞书、后端读到的都是它，没有各自的副本。

## 三类状态

| 状态 | 在哪 | 性质 |
|---|---|---|
| 流式增量 | SSE 事件流 | 只用于实时渲染，丢了不影响结果 |
| 共享事实 | `conversation_ledger` | 只追加，所有端从它重放 |
| Agent 的语义历史 | `agent_context_*` | 只存指向账本的引用与派生条目 |

流式增量永远不进产品事实。遥测是另一回事：只有白名单里的事件类型会落 `agent_run_event`。

## 人的消息什么时候成为事实

人一发消息就写账本，紧接着才创建 Run。这一步是产品事实，也是触发判定的依据。

## Agent 的消息什么时候成为事实

只有终态提交那一刻。`commitCompletedRun` 在一个事务里写账本行、追加 Context 引用、CAS 分支、CAS Run。canonical 序列里的每条消息各占一行，提交身份是 `(agent_run_id, message_index)`。

失败的 Run 也会落一条用户可见的错误消息（messageId 是 `run:<runId>:error`），但它不是 canonical 提交。`commit_failed` 的 Run 什么都不写。

## Context 怎么跟上账本

**取 Run 时同步**：读游标之后未 undone 的账本行，只留 `kind = "message"` 且非 internal 的，取最后 20 条，逐条追加一个 `ledger_message` 引用，然后把游标推到扫过的最后一条。这件事**每次取 Run 都自动发生**，不需要谁显式操作。

**终态提交时再追加**：提交事务里对新写的那些行补引用，并按 `(tree_id, ledger_seq)` 去重。

**显式追加**：`history_retain` 是针对「Run 已经取过了、之后才到达的消息」的补充路径——先校验消息存在且可见，再在同一个事务里写引用和产品工具调用行。只读工具什么都不加。

## 投影交付给子进程的形态

每次派单都会从分支重建一份完整投影。但**投影本身不在 wire 契约里**：它只在分支上还没有 `cli_session_ref` 时，被渲染成一段扁平文本拼进首轮输入。从第二轮起，`cli_session_ref` 存在，子进程直接用自己的 session transcript 当种子历史，这段桥不再出现。

也就是说：历史事实永远是账本，每次投影都重建，但交付形态取决于有没有会话引用。

## 产品摘要与运行时 compaction

两者不是一回事。

**产品摘要**（Context 里的 `summary` 条目）本来是设计给「产品级压缩」的：投影时遇到 summary 就用它覆盖它声明覆盖的那段历史。但**当前没有任何生产者**——`appendSummary` 只有测试在调，投影里的 summary 分支在生产路径上不可达。对话的 `/compact` 与 `/clear` 都是显式空操作。

**运行时 compaction** 完全发生在子进程内部：它自己的 session 里做切点与摘要，通过 `compaction_start` / `compaction_end` 事件把进展透出来，产品侧不读它的结果、也不据此改 Context。

## 语义恢复靠什么

当前的真源是三个：账本、Context 树、以及分支上的 `cli_session_ref`（加上它指向的 CLI session 文件）。

注意第三个：只靠账本和树恢复不出完整语义——子进程的原生 session 里还有账本不承载的东西（它的工具调用历史、它自己的压缩结果）。

## 审计事实

`agent_run.terminal_result`、`product_tool_call`、`agent_run_event` 遥测、`surface_health`。它们用来做审计、重放、排障，不参与消息语义。

## 不变量

1. Message 只有一个本体，账本存它的序列化形态。
2. 流式增量不进账本、不进 Context。
3. 人的消息先落账本再创建 Run。
4. Agent 的消息与 Context 引用同事务提交，提交身份是 `(agent_run_id, message_index)`。
5. Context 只存引用，事实在账本里。
6. 每次派单重建投影；续接由 CLI session 引用负责。
7. 审计数据不参与消息语义。
