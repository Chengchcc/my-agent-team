---
id: conversation.ledger
title: 对话账本
status: current
owners: architecture
last_verified_against_code: 2026-06-22
depends_on:
  - foundations.facts-and-projections
used_by:
  - backend.conversation-projection
  - surfaces.web
  - surfaces.lark-adapter
---

# 对话账本


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


`forkRun` 时调用，从 ledger 直接读对话历史，按 memberId 折叠成 `Message[]`：

- 同 memberId → `{role:"assistant"}`
- 不同 memberId → `{role:"user"}`
- `kind !== "message"` 的条目跳过
- 同一 messageId 后写覆盖先写（streaming → done 折叠）


## ledger → UI：broadcastMessage


## 失败模式

- **重复 assistant 消息**：`hasLedgerContent(runId, content)` 按 runId + 序列化内容去重；`ledgerHasTerminalForMessage` 扫描 ledger 确认没有同 messageId 的 terminal 条目。
- **缺失 assistant 消息**：直写失败是 critical path，上抛，run 标 error。
- **草稿残留**：ledger 最终消息没到，或 messageId 没匹配上。

## 不变量

1. 账本是追加式 canonical store，assistant 与人类消息经同一 `appendLedgerEntry` 入口。
2. 账本只装对话可见内容，不装 tool call 内部细节。
3. 端不绕过后端直接改账本。

## 关联页面

- [会话投影](../backend/conversation-projection.md)
- [事实与投影](../foundations/facts-and-projections.md)
- [Web 端](../surfaces/web.md)
- [Lark 适配器](../surfaces/lark-adapter.md)
- [数据模型](../backend/data-model.md)
