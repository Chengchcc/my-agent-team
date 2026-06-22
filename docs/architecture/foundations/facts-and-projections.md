---
id: foundations.facts-and-projections
title: 事实与投影
status: current
owners: architecture
last_verified_against_code: 2026-06-22
summary: "Message 领域类型只有一处定义（@my-agent-team/message）。conversation_ledger 是对话的 canonical fact store。其余都是 infrastructure：EventLog 只存 execution detail、buildPreloadedMessages 是纯投影函数、projection_messages 是 broadcast cache、Checkpointer 存 recovery state、SSE 是 transport。没有任何层复制 Message 语义。"
depends_on:
used_by:
  - backend.conversation-projection
  - backend.data-model
  - operations.troubleshooting
---

# 事实与投影

**Message 领域类型只有一处定义**：`@my-agent-team/message` 的 `Message` / `MessageRevision`。其它层都引用这个类型，没有自己再造一个 "Message"。

```
@my-agent-team/message
 ├── Message          { role, text?, blocks? }        ← Agent 看到的对话轮次
 ├── MessageRevision  { messageId, state, ... }       ← 带生命周期的消息 envelope
 └── ContentBlock     { type, text?, tool_use?, ... } ← 消息内容块
```

## 事实层与 infrastructure

| 层 | 持久 | 角色 | 写者 | 读者 | 可重建 |
|---|---:|---|---|---|---|
| **事实** | | | | | |
| conversation_ledger | 是 | 对话的 canonical store | ConvService（人）/ onRunMessage（assistant） | buildPreloadedMessages、SSE、Web | 否 |
| **infrastructure** | | | | | |
| EventLog | 是 | execution detail 记录 | RunSupervisor（非 message 事件） | Ops、排障 | 否 |
| buildPreloadedMessages | 否（纯函数） | ledger → Message[] | forkRun closure | Runner 启动 | 是 |
| projection_messages | 是 | broadcast cache | broadcastMessage（best-effort） | SSE subscriber 轮询 | 是 |
| Runner Checkpointer | 是 | recovery state | Framework / Runner | Runner resume | 部分 |
| SSE 流 | 否 | transport | RunSupervisor / ConvService | Web / Lark 实时 UI | 否 |

### 为什么这些不能合并

- **ledger vs EventLog**：ledger 存对话可见内容，EventLog 存 execution detail（tool_start/tool_end 等）。tool call 细节排障需要，但进了 ledger 会让 Lark 消息卡片渲染出 `[Unsupported content]`。反过来，成员加入通知属于 ledger，跟哪次 run 都没关系。
- **ledger vs projection_messages**：projection_messages 是 best-effort cache，进程重启或 fan-out 失败就会丢。buildPreloadedMessages 直接从 ledger 读，不经过 projection_messages，没有 staleness 问题。
- **ledger vs Checkpointer**：Checkpointer 是 Runner 进程私有的 recovery state，不是对话历史。resume 用它恢复执行位置，不是用它回放对话。

## 数据流

```mermaid
flowchart LR
  Human[人的消息] --> Ledger[(conversation_ledger)]
  Sup[RunSupervisor] -->|onRunMessage 直写| Ledger
  Ledger --> BPM[buildPreloadedMessages]
  BPM -->|Message[]| Spec[preloadedMessages]
  Spec --> Runner[Runner]
  Runner --> CKPT[(Runner Checkpointer)]
  Runner --> Sup
  Sup -->|非 message 事件| EventLog[(EventLog)]
  EventLog --> OpsUI[Ops / 排障]
  Ledger -->|broadcastMessage best-effort| TP[(projection_messages)]
  TP --> SSE[SSE subscriber]
  Ledger -->|SSE subscribeConversation| ConvUI[对话 UI]
```

## 关键路径

- **人发消息**：`postMessage → appendAndBroadcast`（写 ledger + broadcastMessage fan-out）
- **assistant 产出**：`onRunMessage → appendAssistantMessage`（直写 ledger）→ `broadcastMessage`（best-effort fan-out，fire-and-forget）
- **Agent 看到什么**：`buildPreloadedMessages` 从 ledger 读 → 按 memberId 折叠（self→assistant，other→user）→ 产出 `Message[]` 给 `preloadedMessages`
- **UI 怎么更新**：`subscribeConversation` SSE 从 ledger 直接 poll

## buildPreloadedMessages vs broadcastMessage：两个投影

| | buildPreloadedMessages | broadcastMessage → projection_messages |
|---|---|---|
| 触发时机 | forkRun（运行开始前） | 每次 ledger 写入后 |
| 输入 | ledger 全量 `getLedgerEntries` | 单条 LedgerEntry |
| 输出 | `Message[]` 直接给 Runner | `{role, content}` 写入 projection_messages |
| 可靠性 | critical（读失败上抛） | best-effort（失败只记日志） |
| 消费方 | Agent（preloadedMessages） | SSE subscriber / Web UI |

## 失败模式

### ledger 写入成功但 broadcast 失败

前端 SSE 有延迟/缺失，但事实已持久化。重连后从 ledger 重放。

### buildPreloadedMessages 读到不完整数据

按 messageId 折叠（后写覆盖先写）。如果同一消息有两个 messageId 则折叠失效导致重复。当前 messageId 由 `assistantMessageId(runId, 0)` 生成，同一 run 内 stable。

### Lark 渲染出 `[Unsupported content]`

纯 `tool_use`/`tool_result` block 进了 ledger。过滤应在 `onRunMessage` 回调或 Lark adapter 的 `renderRevision` 做。

## 不变量

1. Message 领域类型只有 `@my-agent-team/message` 一处定义。
2. conversation_ledger 是对话消息的 canonical fact store。
3. EventLog 只含 execution detail（tool_start/tool_end/text_delta），不含对话内容。
4. buildPreloadedMessages 从 ledger 直接构建 Message[]，不经过 projection_messages。
5. projection_messages 是 broadcast cache，可随时从 ledger 重建。
6. Checkpointer 不是对话历史库。
7. SSE 流不定义事实。

## 关联页面

- [对话账本](../conversation/ledger.md)
- [EventLog](../backend/event-log.md)
- [会话投影](../backend/conversation-projection.md)
- [常驻 Runner](../runner/resident-runner.md)
- [Web 端](../surfaces/web.md)
