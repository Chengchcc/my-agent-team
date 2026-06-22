---
id: operations.troubleshooting
title: 排障手册
status: current
owners: architecture
last_verified_against_code: 2026-06-22
summary: "这一页把常见故障按「症状 → 该去哪条事实线查 → 根因方向」组织起来。核心心法是：先判断问题落在哪一层——是对话事实（账本）错了，还是投影/流（线程投影、SSE）错了，还是执行(Runner / 事件日志)错了——再顺着对应的存储和不变式去定位，而不是一上来就乱翻日志。"
depends_on:
  - foundations.facts-and-projections
  - backend.conversation-projection
  - backend.run-supervisor
used_by:
---

# 排障手册

这一页把常见故障按「症状 → 该去哪条事实线查 → 根因方向」组织起来。核心心法是：先判断问题落在哪一层——是对话事实（账本）错了，还是投影/流（线程投影、SSE）错了，还是执行(Runner / 事件日志)错了——再顺着对应的存储和不变式去定位，而不是一上来就乱翻日志。

## 先分层，再定位

遇到问题，先问一句：这是**事实**坏了，还是**投影**坏了？

- 账本（conversation_ledger）和事件日志（event_log）是durable 事实；
- 线程投影（projection_messages）、SSE 流是投影；
- Runner 本地 checkpointer.sqlite 是执行恢复状态。

事实错了影响所有端，投影错了只影响某个端/某个成员的视图。这一刀切下去，排查范围立刻缩小。

## 症状对照

| 症状 | 先看哪里 | 根因方向 |
|------|----------|----------|
| 某成员看不到本该有的消息 | 该成员的线程投影（thread_id = conversationId:memberId） | `broadcastMessage` fan-out 失败；thread 推导错；账本其实有、投影缓存没跟上 |
| 所有人都缺同一条消息 | 对话账本 + 运行事件 | `onRunMessage` 直写失败（critical，会抛错）；或 Runner 没产出该 message 事件 |
| 飞书收到重复消息 | 飞书适配器 `canSkipFinalLedgerText` | 首次投递必发的特性叠加终稿重发；去重条件未命中 |
| Web 状态卡在 running 不收尾 | run_done → run_finalized 握手 | 收尾顺序某步未完成；delta 订阅未关闭 |
| 运行崩溃后无法恢复 | Runner 本地 checkpointer.sqlite | 中断状态未 saveInterrupt，或被 consumeInterrupt 重复消费 |
| Runner 被误判失联 | 心跳/健康周期 | 连续错过心跳（5000ms）超过 daemon 检查（10000ms）容忍 |
| Agent 活没干完就停 | task-guard / maxForceContinues | 强制继续已用满 3 次；待办状态没正确标 done |

## 关键不变式（违反即 bug）

排障时拿这几条当标尺，违反了基本就是根因：

- **message 事件直写账本、非消息事件进 EventLog**：`message` 事件经 `onRunMessage`（critical, awaited）直写对话账本，不进 EventLog；其它事件才 `eventLog.append`。若看到 assistant 消息出现在 EventLog 里，或对话账本缺了某条 assistant 消息，说明分流被破坏。
- **run_done 收尾顺序固定**：更新 attempt/run → 关闭 delta 订阅 → 从 `#active` 移除 → 发 run_finalized（控制信号优先）→ fire-and-forget onRunComplete。任一步乱序都可能导致悬挂或重复。
- **账本是唯一对话事实来源**：任何端（Web/飞书）若和账本不一致，错的是端的投影，不是账本。

## 关联页面

- [事实与投影](../foundations/facts-and-projections.md)
- [会话投影](../backend/conversation-projection.md)
- [运行编排器](../backend/run-supervisor.md)
- [飞书适配器](../surfaces/lark-adapter.md)
