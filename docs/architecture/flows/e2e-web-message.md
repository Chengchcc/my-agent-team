---
id: flows.e2e-web-message
title: Web 消息端到端
status: current
owners: architecture
last_verified_against_code: 2026-06-16
summary: "这条流追踪一条 Web 用户消息：从乐观 UI，经账本追加、运行触发、Runner 执行、EventLog 追加、会话投影，到最终 UI 对账。它把前面几页的概念串成一次完整往返。"
depends_on:
  - surfaces.web
  - backend.conversation-projection
  - backend.run-supervisor
used_by:
---

# Web 消息端到端

这条流追踪一条 Web 用户消息：从乐观 UI，经账本追加、运行触发、Runner 执行、EventLog 追加、会话投影，到最终 UI 对账。它把前面几页的概念串成一次完整往返。

## 时序图

```mermaid
sequenceDiagram
  participant U as 用户
  participant W as Web
  participant B as Backend
  participant L as 账本
  participant S as RunSupervisor
  participant D as Runner
  participant E as EventLog
  participant P as 会话投影

  U->>W: 发消息
  W->>W: 加乐观消息（opt-）
  W->>B: POST /api/conversations/:id/messages
  B->>L: 追加「人」账本条目
  L-->>W: 账本 SSE 回声替换乐观消息
  B->>S: 触发目标 Agent 运行
  S->>D: start(AgentSpec)
  D-->>S: text_delta / 工具事件
  S-->>W: 运行流 SSE → 更新草稿
  D->>S: event(message)
  S->>E: 先 append EventLog
  S->>P: onRunEvent → 投影
  P->>L: 追加 assistant 账本条目（{text,runId}）
  L-->>W: 账本 SSE assistant 消息
  W->>W: 清掉匹配的草稿
  D->>S: run_done
  S->>D: run_finalized
```

## 几条边界

- 乐观「人」消息是临时的；账本「人」消息是持久的。
- 运行流草稿是临时的；被投影的 assistant 账本消息是持久的。
- 工具进度属于运行 UI，除非被显式总结进文本，否则不进账本。

## 数据形状的逐步变换

1. Web 表单文本 → POST body。
2. POST body → 账本 `kind=message`（human 成员）。
3. 账本 → 目标 Agent 的线程投影。
4. 线程投影 → `start` 消息的 `preloadedMessages`。
5. Agent 产出 → EventLog `message` 事件。
6. EventLog 消息 → 投影信封 `{ text, runId }`。
7. 信封 → Web reducer 账本消息（`norm` 解出内层文本）。

## 出问题先看哪层

| 症状 | 可能层 | 接着读 |
|---|---|---|
| 用户消息消失 | 账本/乐观替换 | [对话账本](../conversation/ledger.md) |
| 草稿闪烁 | Web reducer + 投影 | [Web 端](../surfaces/web.md) |
| 最终答案缺失 | EventLog 或投影 | [会话投影](../backend/conversation-projection.md) |
| Agent 没跑 | 触发 / RunSupervisor | [对话与成员](../conversation/conversation-and-members.md) |

## 关联页面

- [Web 端](../surfaces/web.md)
- [RunSupervisor](../backend/run-supervisor.md)
- [会话投影](../backend/conversation-projection.md)
- [事实与投影](../foundations/facts-and-projections.md)
