---
title: Compaction
description: 四个触发入口、切点算法与 tool 配对回退、摘要写回与无进展守卫、上下文重建，以及与 pruning 和 CLI session 文件的关系
tags: [oma, runtime, context, models]
---

# Compaction

一句话：本页是 oma 内 compaction 的权威描述。它是子进程内的 Run 局部机制：按 token 预算把旧消息折成一条摘要条目，摘要置顶、原条目不删，所以上下文可以无损重建；子进程退出即消失，产品侧不参与。

## 范围

覆盖：触发集合、切点算法、tool 配对回退、摘要写回与无进展守卫、上下文重建、与 CLI session 文件的关系。

不覆盖：工具结果的按需修剪（见 [Oma Tools](./oma-tools.md) 的超时与预算一节）、产品侧的 run 状态（见 [Run 输出与实时更新](../runs/output-and-live-updates.md)）、oma 运行时总览（见 [Oma Runtime](./oma.md)）。

## 实现文件

- `apps/oh-my-agent/src/core/runtime/compaction.ts` — `findCut`、`adjustCutForToolPairs`、`latestCompaction`、`compactSession`
- `apps/oh-my-agent/src/core/runtime/agent-loop-runner.ts` — 三个自动触发点与 `runCompactionRecovery`
- `apps/oh-my-agent/src/core/runtime/run-runtime.ts` — 摘要闭包与 `contextBudget`
- `apps/oh-my-agent/src/core/runtime/agent-loop-run.ts` — `readBranchMessages`，上下文重建
- `apps/oh-my-agent/src/core/store/session-tree.ts` — 条目类型（message / compaction）
- `apps/oh-my-agent/src/core/session/session-file.ts` — 摘要写进 CLI session 文件与 resume 时的折叠
- `apps/oh-my-agent/src/modes/tui/tui-commands-session.ts` — `/compact`

## 触发

四个入口，前三个自动、第四个手动，都汇到同一个 `compactSession`：

| 触发 | 条件 | 说明 |
|---|---|---|
| 阈值 | 活跃上下文估算超过 `limit × 0.7` | 估算只算**还活着**的条目（已被上次 compaction 覆盖的前缀不算），摘要本身也计 token |
| 静默溢出 | provider 收下了超长请求，靠 `usage` 与 `stopReason` 判定 | 同一个 turn 内压缩后重试该次模型调用 |
| provider 溢出错误 | `ProviderError.kind === "overflow"` | 同一个 turn 内压缩后重试一次 |
| 手动 | TUI 的 `/compact` | 直接调 Run 的 `compact()` |

静默溢出与 provider 溢出错误共用一个一次性守卫 `overflowCompacted`：一个 Run 只消费一次。阈值触发的没有守卫，因为它随时可以再触发，安全性由下面的"无进展守卫"保证。

`limit` 是本次 Run 模型的 `contextWindow`，`triggerRatio` 硬编码 0.7。恢复时压缩的目标是 `limit × min(1, triggerRatio)`——压到触发线而不是压到上限，否则刚压完就还在阈值之上，下一轮会再压一次、把上一轮刚保留的尾巴也吃掉。

## 切点算法

`findCut` 从**最旧的一端**开始累加 token，逐条扣除直到剩余量落在 limit 以内，得到切点；然后把切点钳到 `messages.length - 1`，**绝不吃掉最新一条消息**（否则极端情况下超大条目会把整段对话都覆盖掉，模型连摘要都看不到）。没有预算时退化成按条数切 `floor(len × 0.6)`。

随后只做一处修正：若切点正好落在一条 `tool` 角色的消息上（即切在 assistant 的 tool_use 与它的 tool_result 之间），把切点前移到那条 assistant 消息之前，让配对完整。除此之外没有别的筛选条件——不存在"只在 user 或 assistant 处切"这类规则，切点可以落在任何一条消息之前。

两条短路：消息总数少于 4 条时直接返回空结果；切点算下来不大于 0 时同样不动（上下文本来就没超）。

## 摘要与写回

`compactSession` 把被覆盖的消息（含 tool 块，工具语义要活着进摘要）交给 summarizer，然后向 store 追加一条：

```ts
{ type: "compaction", summary, coversEntryIds, tokensBefore?, retainedEntryIds?, createdAt }
```

原始 message 条目**不删**。摘要的生成用的是本次 Run 自己的模型与凭证，带一个模型调用同款的死线（默认 300s）；这里没有"把上一版摘要再喂进去迭代更新"的协议，每份摘要都是独立生成的。

两处守卫：

- 摘要期间被 abort → 不写任何条目。
- 无进展守卫：若这次要覆盖的条目全都已被更早的 compaction 覆盖过，立即返回空结果，不调 summarizer、不写条目。这是"按预算触发"能安全反复触发的原因——没有常驻的"已压缩过"标志（那种标志曾经试过，会从循环观测不到的状态里被重新武装，结果是主动压缩在 Run 剩下的时间里静默失效）。

summarizer 抛错不算 Run 失败：压缩是尽力而为的优化，失败只写调试日志，随后照常发模型请求。

## 上下文重建

`readBranchMessages` 取一支的条目，按最新一条 compaction 的 `coversEntryIds` 过滤掉被覆盖的条目，再把摘要作为一条 `[Context summary: …]` 的 user 消息置顶。摘要的置顶**不依赖是否还有消息存活**。

## 与 pruning 的关系

工具结果修剪（`prune`）是**独立的可选机制**，不是 compaction 的第一阶段：只有工作区配了 `prune` 才跑，且在同一个 turn 内先于阈值检查执行，能把旧 tool_result 截断到摘要形式，省下来的量可能让这次压缩根本不需要发生。两者共用同一个 token 估算器，否则"省下的 token"与"预算减掉的 token"不可比。

## 与 CLI session 文件的关系

Run 结束时把每条 compaction 追加进 CLI 自己的 session 文件，同时带一个 `replacesEarlierMessages` 标记：只有摘要描述的是该分支**全部**存活消息时它才为真，此时 resume 才会把摘要之前的消息折叠成一条 `<previous_session_summary>` 标记。用布尔而不是计数，是因为分支的覆盖范围与会话文件的消息事件是两套索引空间，计数会静默丢消息。

## 不变量

1. 原消息条目不删；覆盖范围记在 compaction 条目上，摘要只影响重建时的过滤。
2. 每次压缩绝不覆盖最新一条消息。
3. 一个 Run 最多消费一次溢出恢复；阈值触发可以多次，但无进展时不动手。
4. 摘要失败或中途被 abort 都不改变 Run 的终态。
5. 压缩是子进程内的行为，产品不参与也不需要知道。

## 已知缺口

- `triggerRatio` 与 `limit × 0.7` 的关系是硬编码的，不能按工作区调。
- summarizer 的提示词是一句固定的 system 文本，没有分节模板，摘要的结构完全靠模型自由发挥。
- 摘要失败只写调试日志，终端上没有任何可见信号。

## 相关页

- [Oma Runtime](./oma.md) — per-Run 状态与 loop
- [Oma Tools](./oma-tools.md) — `prune` 旋钮与超时
- [Agent Context](../agents/context.md) — 产品侧的历史与投影
