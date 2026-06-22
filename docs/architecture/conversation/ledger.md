---
id: conversation.ledger
title: 对话账本
status: current
owners: architecture
last_verified_against_code: 2026-06-22
summary: "conversation_ledger 是对话历史的 canonical store。assistant 消息由 Supervisor onRunMessage 经 appendAssistantMessage 直写（底层 appendLedgerEntry），人类消息经 postMessage → appendAndBroadcast。buildPreloadedMessages 从 ledger 直接构建 Agent 看到的 Message[]，不走 projection_messages。"
depends_on:
  - foundations.facts-and-projections
used_by:
  - backend.conversation-projection
  - surfaces.web
  - surfaces.lark-adapter
---

# 对话账本

conversation_ledger 是对话历史的 canonical store。它是一张 append-only 表，人发的消息和 Agent 产出的消息都写在这里。写完之后，两个东西会消费它：`buildPreloadedMessages` 从这里给 Agent 构建上下文；`broadcastMessage` 从这里往各端的 SSE subscriber 推更新。

## 条目结构

```ts
{
  seq: number,          // 自增，写入口返回
  conversationId: string,
  senderMemberId: string,
  addressedTo: string[],
  kind: "message" | "member.joined" | "member.left" | "todo" | "surface.control",
  content: string,      // JSON — message kind 存 MessageRevision 序列化
  ts: number,
  runId?: string        // assistant 消息写入口携带，人/系统消息不填
}
```

读：`getLedgerEntries(conversationId, { sinceSeq? })`，按 `seq > sinceSeq ORDER BY seq ASC`。

## content 的几种形状

| 形状 | 含义 |
|---|---|
| MessageRevision JSON | assistant 或人类消息的 envelope（messageId / state / role / blocks） |
| 自定义 JSON | todo、surface.control、member.joined、member.left 的 payload |

`runId` 是 LedgerEntry 的顶层字段，不在 content JSON 里面。

## 两条写入路径

| 路径 | 调用链 | 触发方 | fan-out |
|------|--------|--------|------|
| 人类消息 | `postMessage → appendAndBroadcast` | Web / [Lark](../surfaces/lark-adapter.md) / API | appendAndBroadcast 内部 broadcastMessage（同步） |
| assistant 消息 | `onRunMessage → appendAssistantMessage` | RunSupervisor | onRunMessage 回调内 broadcastMessage（fire-and-forget） |

底层都是 `port.appendLedgerEntry()`。区别：人类消息把 ledger write 和 broadcast 包在一个函数里；assistant 消息分开调——在不同回调触发，fan-out 失败不阻塞 run event 处理。

## ledger → Agent：buildPreloadedMessages

`forkRun` 时调用，从 ledger 直接读对话历史，按 memberId 折叠成 `Message[]`：

- 同 memberId → `{role:"assistant"}`
- 不同 memberId → `{role:"user"}`
- `kind !== "message"` 的条目跳过
- 同一 messageId 后写覆盖先写（streaming → done 折叠）

**不经过 `projection_messages`。**

## ledger → UI：broadcastMessage

每次 ledger 写入后，`broadcastMessage` 对每个 agent member 调 `projectForMember`，结果写进 `projection_messages`。SSE subscriber 通过 `threadProjectionRoutes` HTTP API 轮询该表。这是 broadcast cache——丢或延迟不影响事实，重连从 ledger SSE 重放。

## 失败模式

- **重复 assistant 消息**：`hasLedgerContent` 幂等检查；`ledgerHasTerminalForMessage` 防重复 terminal 写入。
- **缺失 assistant 消息**：直写失败是 critical path，上抛，run 标 error。
- **preloadedMessages 重复**：`buildPreloadedMessages` 按 messageId 折叠。同一消息如果有两个 messageId 则折叠失效。
- **草稿残留**：ledger 最终消息没到，或 messageId 没匹配上。

## 不变量

1. 账本是追加式 canonical store，assistant 与人类消息经同一 `appendLedgerEntry` 入口。
2. 账本只装对话可见内容，不装 tool call 内部细节。
3. 端不绕过后端直接改账本。
4. `buildPreloadedMessages` 从 ledger 直接构建 Message[]，不经过 projection_messages。

## 关联页面

- [会话投影](../backend/conversation-projection.md)
- [事实与投影](../foundations/facts-and-projections.md)
- [Web 端](../surfaces/web.md)
- [Lark 适配器](../surfaces/lark-adapter.md)
- [数据模型](../backend/data-model.md)
