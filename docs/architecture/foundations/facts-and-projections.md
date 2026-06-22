---
id: foundations.facts-and-projections
title: 事实与投影
status: current
owners: architecture
last_verified_against_code: 2026-06-22
summary: "Message 领域类型只有一个（@my-agent-team/message）。对话账本（conversation_ledger）是对话事实的唯一持久容器——人与 assistant 消息经同一入口写入。其余全是机制层：EventLog 只存执行细节、buildPreloadedMessages 是纯投影函数、projection_messages 是广播缓存、Checkpointer 是执行恢复状态、SSE 是传输通道。没有任何层复制 Message 的语义模型。"
depends_on:
used_by:
  - backend.conversation-projection
  - backend.data-model
  - operations.troubleshooting
---

# 事实与投影

**领域层只有一个 Message 类型**（`@my-agent-team/message` 的 `Message` / `MessageRevision`）。对话账本是对话事实的唯一持久容器。其它层都是投影、缓存或传输机制——没有任何一层复制 Message 的语义模型。

## 领域模型（唯一）

```
@my-agent-team/message
 ├── Message          { role, text?, blocks? }        ← Agent 看到的对话轮次
 ├── MessageRevision  { messageId, state, ... }       ← 带生命周期的消息信封
 └── ContentBlock     { type, text?, tool_use?, ... } ← 消息内容块
```

这是系统里**唯一**的 Message 语义定义。其它所有层都在引用这个类型，没有定义一个"自己版本的 Message"。

## 事实层与机制层

| 层 | 持久 | 角色 | 写者 | 读者 | 可重建 |
|---|---:|---|---|---|---|
| **事实** | | | | | |
| conversation_ledger | 是 | 对话事实的唯一容器 | ConvService（人）/ onRunMessage（assistant） | buildPreloadedMessages、SSE、Web | 否 |
| **机制** | | | | | |
| EventLog | 是 | 执行细节记录 | RunSupervisor（非消息事件） | Ops、排障 | 否 |
| buildPreloadedMessages | 否（纯函数） | 从账本构建 Message[] | forkRun 调用方 | Runner 启动 | 是 |
| projection_messages | 是 | 广播缓存 | broadcastMessage（best-effort） | SSE 订阅者轮询 | 是 |
| Runner Checkpointer | 是 | 执行恢复状态 | Framework / Runner | Runner resume | 部分 |
| SSE 流 | 否 | 传输通道 | RunSupervisor / ConvService | Web / 飞书实时 UI | 否 |

### 为什么不能合并

- **账本 vs EventLog**：账本是对话可见历史，EventLog 是执行历史。`tool_start`/`tool_end` 排障需要但不能进账本（飞书会渲染 `[Unsupported content]`）。成员加入通知在账本有意义，但不属于任何一次运行。
- **账本 vs projection_messages**：`projection_messages` 是 best-effort 广播缓存，可能丢（进程重启、扇出失败）。`buildPreloadedMessages` 从账本直接构建，不走 `projection_messages`，消除了中间层的 staleness 风险。
- **账本 vs Checkpointer**：Checkpointer 是 Runner 进程私有的执行状态，不是对话历史。`resume` 用它恢复，不是用它回放对话。

## 关系图

```mermaid
flowchart LR
  Human[人的消息] --> Ledger[(conversation_ledger)]
  Sup[RunSupervisor] -->|onRunMessage 直写| Ledger
  Ledger --> BPM[buildPreloadedMessages]
  BPM -->|Message[]| Spec[preloadedMessages]
  Spec --> Runner[Runner]
  Runner --> CKPT[(Runner Checkpointer)]
  Runner --> Sup
  Sup -->|非消息事件| EventLog[(EventLog)]
  EventLog --> OpsUI[Ops / 排障]
  Ledger -->|broadcastMessage best-effort| TP[(projection_messages)]
  TP --> SSE[SSE 订阅者]
  Ledger -->|SSE subscribeConversation| ConvUI[对话 UI]
```

## 关键规则

- **人发消息**：`postMessage → appendAndBroadcast（写账本 + broadcastMessage 扇出）`
- **assistant 产出**：`onRunMessage → appendAssistantMessage（直写账本）→ broadcastMessage（best-effort 扇出，fire-and-forget）`
- **Agent 看到什么**：`buildPreloadedMessages` 从账本读 → 按 memberId 折叠（self→assistant，other→user）→ 产出 `Message[]` 给 `preloadedMessages`
- **UI 怎么更新**：`subscribeConversation` SSE 从账本直接 poll → `projection_messages` HTTP 轮询供旧路径兼容

## buildPreloadedMessages vs broadcastMessage：两个投影，用途正交

| | buildPreloadedMessages | broadcastMessage → projection_messages |
|---|---|---|
| 触发时机 | forkRun（运行开始前） | 每次账本写入后 |
| 输入 | 账本全量 `getLedgerEntries` | 单条 LedgerEntry |
| 输出 | `Message[]` 直接给 Runner | `{role, content}` 写入 projection_messages |
| 可靠性 | 关键路径（读失败上抛） | best-effort（失败只记日志） |
| 消费方 | Agent（preloadedMessages） | SSE 订阅者 / Web UI |

## 失败模式

### 账本写入成功但 broadcast 失败

前端 SSE 可能有延迟/缺失，但事实已持久化。重连从账本重放即可恢复。

### buildPreloadedMessages 读到不完整数据

`buildPreloadedMessages` 按 messageId 折叠（后写覆盖先写）。如果同一消息有两个 messageId，折叠失效导致重复。当前 messageId 由 `assistantMessageId(runId, 0)` 生成，同一 run 内 stable。

### 飞书渲染出 `[Unsupported content]`

纯 `tool_use`/`tool_result` 的 assistant 块进了账本。过滤应在调用方（`onRunMessage`）或渲染方（`renderRevision`）完成。

## 不变量

1. Message 领域类型只有 `@my-agent-team/message` 一处定义。
2. conversation_ledger 是对话消息的**唯一**事实容器。
3. EventLog 仅含执行细节（tool_start/tool_end/text_delta），不含对话内容。
4. `buildPreloadedMessages` 从账本直接构建 Message[]，不经过 projection_messages。
5. `projection_messages` 是广播缓存，可随时从账本重建。
6. Checkpointer 不是对话历史库。
7. SSE 流不定义事实。

## 关联页面

- [对话账本](../conversation/ledger.md)
- [EventLog](../backend/event-log.md)
- [会话投影](../backend/conversation-projection.md)
- [常驻 Runner](../runner/resident-runner.md)
- [Web 端](../surfaces/web.md)
