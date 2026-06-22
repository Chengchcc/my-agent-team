---
id: surfaces.overview
title: 端总览
status: current
owners: architecture
last_verified_against_code: 2026-06-16
summary: "端是面向用户的适配器，目前是 Web 和飞书。它们采集输入、渲染账本流、把外部身份映射成成员、处理 UX 层的去重；但它们不拥有任何持久事实。出站路径已统一为账本 SSE——两个端都不再打开独立的运行流。"
depends_on:
used_by:
  - surfaces.web
  - surfaces.lark-adapter
---

# 端总览

端是面向用户的适配器，目前是 Web 和飞书。它们采集输入、渲染账本流、把外部身份映射成成员、处理 UX 层的去重；但它们不拥有任何持久事实。出站路径已统一为账本 SSE——两个端都不再打开独立的运行流。

## 端拥有什么、不拥有什么

端拥有：输入采集、对话历史渲染、外部身份映射、UX 级去重与重试展示。

端不拥有：账本真相、EventLog 真相、Runner checkpoint、Agent 触发语义。

## 通用模式

```mermaid
flowchart LR
  User --> Surface
  Surface -->|消息 API| Backend
  Backend -->|账本 SSE (ConversationMessageRevision)| Surface
  Surface --> User
```

所有消息输出（人类回声、assistant streaming 产出、最终答案、todo）都经账本 SSE 承载。不再有独立的运行流/事件 SSE——`/runs/:id/events` 和 `/runs/:id/stream` 路由已删除。

## Web 与飞书的差异

| 维度 | Web | 飞书 |
|---|---|---|
| 身份 | 应用用户/会话 | 飞书 user/chat |
| 实时产出 | messageId upsert（同 run 的 streaming/done revision 替换同一气泡） | sse-watcher 解析 revision state 驱动投递 |
| 最终产出 | 账本消息 | 账本文本（除非 canSkipFinalLedgerText） |
| busiest 判断 | 检查 agent 消息 state === "streaming"/"waiting" | 检查 run 终态 |
| 消耗的 SSE | 仅账本流 | 仅账本流 |
| 主要风险 | 乐观消息残留 | terminal revision 重复投递 |

## 关联页面

- [Web 端](./web.md)
- [飞书适配器](./lark-adapter.md)
- [对话账本](../conversation/ledger.md)
