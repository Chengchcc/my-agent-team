---
id: operations.troubleshooting
title: 排障手册
status: current
owners: architecture
last_verified_against_code: 2026-06-22
depends_on:
  - foundations.facts-and-projections
  - backend.conversation-projection
  - backend.run-supervisor
used_by:
---

# 排障手册


## 先分层，再定位

遇到问题，先问一句：这是**事实**坏了，or the **projection** is broken？

- 账本（conversation_ledger）和事件日志（event_log）是durable 事实；
- ledger entries、SSE 流是投影；
- checkpointer.db (global).sqlite 是执行恢复状态。

事实错了影响所有端，projection is wrong只影响某个端/某个成员的视图。这一刀切下去，排查范围立刻缩小。

## 症状对照

| 症状 | 先看哪里 | 根因方向 |
|------|----------|----------|
| 某成员看不到本该有的消息 | 该成员的 ledger entries（thread_id = conversationId:memberId） | `broadcastMessage` fan-out 失败；thread 推导错；账本其实有、投影缓存没跟上 |
| 所有人都缺同一条消息 | 对话账本 + 运行事件 | `onRunMessage` 直写失败（critical，会抛错）；或 Runner 没产出该 message 事件 |
| 飞书收到重复消息 | 飞书适配器 `canSkipFinalLedgerText` | 首次投递必发的特性叠加终稿重发；去重条件未命中 |
| Web 状态卡在 running doesn't complete | run_done → run_finalized 握手 | completion sequence某步未完成；delta 订阅未关闭 |
| 运行崩溃后无法恢复 | checkpointer.db (global).sqlite | 中断状态未 saveInterrupt，或被 consumeInterrupt 重复消费 |
| Agent 活没干完就停 | task-guard / maxForceContinues | 强制继续已用满 3 次；待办状态没正确标 done |

## 关键不变式（违反即 bug）

排障时拿这几条当标尺，违反了基本就是根因：

- **message 事件直写账本、非消息事件进 backend 执行事实流**：`message` 事件经 `onRunMessage`（critical, awaited）直写对话账本，不进 backend 执行事实流；其它事件才 `eventLog.append`。若看到 assistant 消息出现在 执行事实流里，或对话账本缺了某条 assistant 消息，说明分流被破坏。
- **run_done completion sequence固定**：更新 attempt/run → 关闭 delta 订阅 → 从 `#active` 移除 → 发 run_finalized（控制信号优先）→ fire-and-forget onRunComplete。任一步乱序都可能导致悬挂或重复。
- **账本是唯一对话事实来源**：任何端（Web/飞书）若和账本不一致，错的是the surface's projection，不是账本。

## 关联页面

- [事实与投影](../foundations/facts-and-projections.md)
- [会话投影](../backend/conversation-projection.md)
- [运行编排器](../backend/run-supervisor.md)
- [飞书适配器](../surfaces/lark-adapter.md)
