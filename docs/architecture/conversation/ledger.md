---
id: conversation.ledger
title: 对话账本
status: current
owners: architecture
last_verified_against_code: 2026-06-22
summary: "对话账本是共享对话历史的唯一持久容器。assistant 消息现在由 Supervisor onRunMessage 经 appendAssistantMessage 直写账本（与人类消息同一条 appendLedgerEntry 底层入口，但不经过 appendAndBroadcast——广播是独立的 best-effort 扇出）。buildPreloadedMessages 从账本直接构建 Agent 要看到的 Message[]，不走 projection_messages 中间层。"
depends_on:
  - foundations.facts-and-projections
used_by:
  - backend.conversation-projection
  - surfaces.web
  - surfaces.lark-adapter
---

# 对话账本

对话账本是共享对话历史的唯一持久容器。assistant 消息现在由 Supervisor 经 `onRunMessage` → `appendAssistantMessage` 直写账本底层入口（`appendLedgerEntry`），人类消息经 `postMessage → appendAndBroadcast`。两者的共同点是都走 `appendLedgerEntry` 写表；区别是人类消息在写入同时做 broadcastMessage 扇出，assistant 消息的扇出在 `onRunMessage` 回调中独立 fire-and-forget。

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
  content: string,   // JSON — message 条目存 MessageRevision 序列化
  ts: number,
  runId?: string      // assistant 消息写入时携带，人类/系统消息不填
}
```

`appendLedgerEntry(input)` 返回新 seq（`Number(lastInsertRowid)`）；读用 `getLedgerEntries(conversationId, { sinceSeq? })`，按 `seq > ? ORDER BY seq ASC`。

## content 的几种形状

| 形状 | 含义 |
|---|---|
| MessageRevision（JSON 后） | assistant/人类消息的信封（messageId/state/role/blocks） |
| 自定义 JSON | todo / surface.control / member.joined / member.left 载荷 |

> `runId` 现在是账本条目的**顶层字段**（`LedgerEntry.runId`），不再嵌入在 content JSON 内部。

## 两条写入路径

| 路径 | 调用链 | 触发方 | 扇出 |
|------|--------|--------|------|
| 人类消息 | `postMessage → appendAndBroadcast` | Web / 飞书 / API | appendAndBroadcast 内部 broadcastMessage（同步） |
| assistant 消息 | `onRunMessage → appendAssistantMessage` | RunSupervisor | onRunMessage 回调内 broadcastMessage（fire-and-forget） |

两条路径的底层都是 `port.appendLedgerEntry()`（同一个 SQL INSERT）。区别仅在于人类消息把 broadcast 和 ledger write 包在一个函数里，assistant 消息分开调——因为它们在不同回调中触发，且 assistant 消息的扇出是 best-effort（不阻塞 run 事件处理）。

## 从账本到 Agent（buildPreloadedMessages）

`buildPreloadedMessages` 在 `forkRun` 时调用，从账本直接读取对话历史，按 member 视角折叠成 `Message[]`：

- 同 memberId 的条目 → `{role:"assistant"}`（Agent 看到自己说过的话）
- 其他 memberId 的条目 → `{role:"user"}`（Agent 看到别人说的话）
- `kind` 不为 `"message"` 的条目直接跳过
- 同一 `messageId` 的后写覆盖先写（streaming → done 折叠为一条）

这条路径**不经过 `projection_messages` 表**——直接从账本构建，消除了中间缓存的 staleness 风险。

## 从账本到 UI（broadcastMessage → projection_messages）

每次账本写入后，`broadcastMessage` 做 best-effort 扇出：对每个 agent member 调用 `projectForMember`，结果写入 `projection_messages` 表。SSE 订阅者通过 `threadProjectionRoutes` HTTP API 轮询该表。这是广播缓存——丢失或延迟不影响事实。

## 账本 vs UI 状态

账本是持久的，UI 状态是临时的：

- Web 的乐观「人」消息，应被账本回声替换。
- Web 的 assistant 草稿，应被账本 assistant 消息替换。
- 飞书的流式卡片状态，应借 runId 与账本最终文本对账。

## 失败模式

- **重复 assistant 消息**：`hasLedgerContent` 提供幂等检查；`ledgerHasTerminalForMessage` 防止重复 terminal 写入。
- **缺失 assistant 消息**：直写路径失败（critical，会上抛）——不再有「EventLog 成了但投影没成」的静默丢失窗口。
- **草稿永远不消失**：账本最终消息没到，或没匹配上草稿那次运行。
- **preloadedMessages 重复**：`buildPreloadedMessages` 按 messageId 折叠；若同一消息有两个 messageId 则折叠失效。

## 不变量

1. 账本是追加式的对话真相容器，assistant 与人类消息经同一 `appendLedgerEntry` 底层入口写入。
2. 账本只该装对话可见内容，不该装纯工具执行内部细节。
3. 端不该绕过后端 API 直接改账本历史。
4. `buildPreloadedMessages` 从账本直接构建 Message[]，不经过 projection_messages。

## 关联页面

- [会话投影](../backend/conversation-projection.md)
- [事实与投影](../foundations/facts-and-projections.md)
- [Web 端](../surfaces/web.md)
- [飞书适配器](../surfaces/lark-adapter.md)
- [数据模型](../backend/data-model.md)
