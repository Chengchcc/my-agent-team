---
id: conversation.ledger
title: 对话账本
status: current
owners: architecture
last_verified_against_code: 2026-06-16
summary: "对话账本是共享对话历史的持久事实。它记录人的消息、被投影进来的 assistant 消息、成员/系统事件，以及个别 UI 可见的控制条目。端只是渲染它；线程投影从它派生出每个 Agent 各自的上下文。"
depends_on:
  - foundations.facts-and-projections
used_by:
  - backend.conversation-projection
  - surfaces.web
  - surfaces.lark-adapter
---

# 对话账本

对话账本是共享对话历史的持久事实。它记录人的消息、被投影进来的 assistant 消息、成员/系统事件，以及个别 UI 可见的控制条目。端只是渲染它；线程投影从它派生出每个 Agent 各自的上下文。

## 这页解决什么问题

一个团队对话需要一份共享历史，能挺过 Web 刷新、飞书重连、Agent 重启、多 Agent 轮流发言。账本就是这份共享历史，也是唯一可被重放的对话真相来源。

## 条目形状

```ts
{
  seq: number,
  conversationId: string,
  senderMemberId: string,
  addressedTo: string[],
  kind: "message" | "member.joined" | "member.left" | "todo" | "surface.control",
  content: string,   // JSON
  ts: number
}
```

`appendLedgerEntry(input)` 返回新 seq（`Number(lastInsertRowid)`）；读用 `getLedgerEntries(conversationId, { sinceSeq? })`，按 `seq > ? ORDER BY seq ASC`。

## content 的几种形状

| 形状 | 含义 |
|---|---|
| `string`（JSON 后） | 纯文本 |
| `ContentBlock[]` | 富模型内容 |
| `{ text, runId }` | 关联某次运行的 assistant 文本 |
| `{ blocks, runId }` | 关联某次运行的 assistant 块 |
| 自定义对象 | todo / surface / system 载荷 |

## 账本 vs UI 状态

账本是持久的，UI 状态是临时的：

- Web 的乐观「人」消息，应被账本回声替换。
- Web 的 assistant 草稿，应被账本 assistant 消息替换。
- 飞书的流式卡片状态，应借 runId 与账本最终文本对账。

## 从账本到线程投影

账本收到消息时，Conversation Service 把它广播进各成员的线程投影。`broadcastMessage` 会跳过 `kind` 为 `todo` 和 `surface.control` 的条目（UI-only）。同一条账本行经 `projectForMember` 对不同成员映射不同：

- 是发送者本人 → 视为 `{role:"assistant"}` 历史。
- 是别人 → 视为 `{role:"user", text:"[名字]: ..."}`。
- 是 `__system__` → 视为 `{role:"user", text:"[系统] ..."}`。

## 失败模式

- **重复 assistant 消息**：投影无幂等键，或端重复发了最终文本。
- **缺失 assistant 消息**：EventLog append 后投影失败。
- **草稿永远不消失**：账本最终消息没到，或没匹配上草稿那次运行。
- **Agent 看到重复上下文**：广播更新线程投影时，Runner 又保存了同一段 assistant 轮次。

## 不变量

1. 账本是追加式的对话真相。
2. 账本只该装对话可见内容。
3. 账本不该装纯工具执行内部细节。
4. 端不该绕过后端 API 直接改账本历史。

## 关联页面

- [会话投影](../backend/conversation-projection.md)
- [事实与投影](../foundations/facts-and-projections.md)
- [Web 端](../surfaces/web.md)
- [飞书适配器](../surfaces/lark-adapter.md)
- [数据模型](../backend/data-model.md)
