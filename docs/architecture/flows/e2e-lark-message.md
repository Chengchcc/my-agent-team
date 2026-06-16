---
id: flows.e2e-lark-message
title: 飞书消息端到端
status: current
owners: architecture
last_verified_against_code: 2026-06-16
summary: "这条流追踪一条飞书消息：从会话绑定、成员映射、账本追加、Agent 运行、流式卡片渲染、投影，到最终文本去重。它解释了为什么飞书用户有时会收到两遍同一个答案。"
depends_on:
  - surfaces.lark-adapter
  - backend.conversation-projection
used_by:
---

# 飞书消息端到端

这条流追踪一条飞书消息：从会话绑定、成员映射、账本追加、Agent 运行、流式卡片渲染、投影，到最终文本去重。它解释了为什么飞书用户有时会收到两遍同一个答案。

## 时序图

```mermaid
sequenceDiagram
  participant U as 飞书用户
  participant Bot as 飞书 Bot
  participant B as Backend
  participant S as RunSupervisor
  participant D as Runner
  participant E as EventLog
  participant P as 投影
  participant L as 飞书

  U->>Bot: 发消息 / @机器人
  Bot->>B: 解析 chat 绑定（无则建会话）
  Bot->>B: 解析 human 成员（无则建）
  Bot->>B: POST 会话消息
  B->>S: 触发 Agent
  S->>D: start(AgentSpec)
  D-->>S: 流式 delta
  S-->>Bot: 运行流 → 更新卡片
  D->>S: event(message)
  S->>E: append EventLog
  S->>P: 投影进账本
  P-->>Bot: 观察到账本消息
  Bot->>Bot: canSkipFinalLedgerText? (首次必为否)
  Bot->>L: 发最终文本（首次都会发）
```

## 绑定模型

飞书适配器要维护四组映射：飞书 chat → 对话；飞书 user → human 成员；Bot/Agent 身份 → agent 成员；飞书卡片/消息 ID → 投递状态。

## 去重模型与为什么会重

一个最终答案能从「流式卡片」和「账本最终文本」两条路出现。去重需要：账本 content 里的 runId 信封、卡片已交付最终内容的记录、可靠的运行终态、以及「账本消息就是最终可读答案」这个认知。

但当前 `completeFromLedger` 只在最终文本成功发出**一次之后**才置 1，所以首次必然发一遍——拿到卡片的用户至少会再收到一次纯文本。详见 [飞书适配器](../surfaces/lark-adapter.md)。

## 出问题先看哪层

| 症状 | 可能成因 | 接着读 |
|---|---|---|
| 最终答案重复 | 投影早于 done / 跳过条件没满足 | [飞书适配器](../surfaces/lark-adapter.md) |
| 不支持的内容 | 纯工具块被投影 | [会话投影](../backend/conversation-projection.md) |
| Agent 没触发 | 绑定/成员/提及问题 | [对话与成员](../conversation/conversation-and-members.md) |
| 消息进错线程 | chat 绑定错 | [数据模型](../backend/data-model.md) |

## 关联页面

- [飞书适配器](../surfaces/lark-adapter.md)
- [会话投影](../backend/conversation-projection.md)
- [对话与成员](../conversation/conversation-and-members.md)
- [排障手册](../operations/troubleshooting.md)
