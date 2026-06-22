---
id: surfaces.web
title: Web 端
status: current
owners: architecture
last_verified_against_code: 2026-06-22
summary: "Web 端是浏览器里的对话界面。它只消费一条 SSE——会话/账本流——在 conversation-reducer 里按 ConversationMessageRevision 的 messageId upsert 到 items[]。items 是 UiItem 联合（message / notice 两种 kind）。不再有草稿、运行阶段、中断状态——busy 从 open message 的 state 字段推导。"
depends_on:
  - conversation.ledger
  - backend.conversation-projection
used_by:
  - flows.e2e-web-message
  - operations.troubleshooting
---

# Web 端

Web 端是浏览器里的对话界面。它只消费一条 SSE——会话/账本流——在 conversation-reducer 里按 ConversationMessageRevision 的 messageId upsert 到 items[]。items 是 UiItem 联合（message / notice 两种 kind）。不再有草稿、运行阶段、中断状态——busy 从 open message 的 state 字段推导。

## 这页解决什么问题

用户既要看到持久的对话历史，又要看到进行中的运行产出。Web 不再维护独立的 draft/run 状态——所有输出（人类消息、assistant 流式产出、最终答案、todo 快照）都作为 ConversationMessageRevision 经账本 SSE 到达，按 messageId upsert 成 `kind: "message"` 的 UiItem。成员加入/离开不是消息，而是 `kind: "notice"` 的 UiItem。实时感来自 revision 的 `state: "streaming"` 增量更新。

## 状态形状（ConvState）

```ts
{
  viewerMemberId: string,
  roster: Record<string, SenderRef>,        // SenderRef.kind 只有 "agent" | "human"
  items: UiItem[],                          // UiItem = { kind: "message"; id; sender; content: Message }
                                            //        | { kind: "notice"; id; text: string }
  streamConn: "connecting" | "open" | "reconnecting" | "closed",
  error: string | null,
  optimisticSeq: number,
  triggerMode: "auto" | "mention",
  todos: Array<{ step, status: "pending" | "in_progress" | "done" }>,
  pendingSendCount: number
}
```

Action 联合（精确）：`bootstrap`、`member`、`message`、`send`、`conn`、`toggleTriggerMode`、`send/error`、`todo/update`。

Run 相关的 action 全部删除：不再有 `run/started`、`stream/delta`、`stream/toolStart`、`stream/toolEnd`、`run/interrupted`、`run/error`、`run/done`、`run/completed`、`run/noop`。不再有 `draft`、`run`、`pendingInterrupt` 字段。

## 唯一 SSE：会话/账本流

`useConversation` 只开一个 EventSource：`/api/bff/conversations/:id/events`。事件类型：

- `message` → `parseRevision(seq, content)` 解出 `ConversationMessageRevision`，按 `messageId` upsert 成 `kind: "message"` 的 UiItem。
- `member.joined` / `member.left` → `member` action，作为 `kind: "notice"` 的 UiItem 入列（不再合成 `role: "system"` 的消息，也不再有 `__system__` sender）。
- `todo` → `todo/update` action。

连接无空闲超时——后端每 ~15s 发一次 SSE comment `: ping\n\n`（heartbeat）保持连接。终端状态不由 SSE `event: done` 表达，而是由 message revision 的 `state: "done"` / `state: "error"` 表达。

## 消息 upsert 与 busy 推导

`message` reducer 分支调用 `parseRevision(a.seq, a.content)`，用 `revision.messageId` 作为 UiItem 的 `id`。`upsertAuthoritative` 按 id 查找同消息（`item.kind === "message" && item.id === id`）——找到就替换，否则对己方消息替换最近一条乐观消息，再否则追加。

`busy` 不再由 run phase 推导。`isBusy()` 纯函数先看 `pendingSendCount > 0`，再检查 `items` 中是否有 `kind === "message"` 的 agent 消息其 `state` 非空且 `isOpenMessageState(state)` 为真：

```ts
export function isBusy(s: ConvState): boolean {
  if (s.pendingSendCount > 0) return true;
  return s.items.some(
    (item) =>
      item.kind === "message" &&
      item.sender.kind === "agent" &&
      item.content.state != null &&
      isOpenMessageState(item.content.state),
  );
}
```

`ConversationCanvas` 用 busy 控制动画点、状态标签（"Running" / "Awaiting Approval"），不再维护 `run.phase`。

## 几个关键纯函数

- `upsertAuthoritative`：有同 messageId 就替换；否则对自己的消息替换最近一条乐观消息（`opt-` 前缀）；再否则追加。revision 的 messageId 保证同 run 增量/终端写入 upsert 到同一 UiItem。
- `isConclusionMessage`：从 `ConversationMessageRevision` 取 `text` 或 `blocks` 判断——有非空 text 且无 tool_use 块即为结论。
- `groupTurns`：把连续同 Agent 消息收成一个 `turn` 段，`conclusion` 取该段最后一条结论，其余进 `rounds`。

## Timeline 锚点

`Timeline` 调 `groupTurns`，`extractAnchors` 把锚点放在 `segmentSender(seg).kind === "human"` 的段上——**锚点按「人发言」边界**。Agent 的 `turn` 段经 `ReasoningTrace` 渲染、不带锚点。`notice` 段独立渲染、不参与 turn 分组。纯 Agent → Agent 链以 sender-change 边界兜底，`isTurnStart` 在 `prevSender.memberId !== sender.memberId` 时也视为 turn 起点。

## 失败模式

- 乐观消息残留：账本回声丢失时 opt- 消息不会被替换。messageId 不匹配时持久消息重复显示。
- 流式文本不刷新：revision 的 messageId 与前序不一致导致独立消息而非 upsert。
- 缺推理：`reasoning_delta` 端到端产生（适配器从 thinking 块发出），但若产品不要推理，应连同上游一起去掉。
- 轮询抖动：不稳定的 effect 依赖会重建 interval。

## 关联页面

- [对话账本](../conversation/ledger.md)
- [会话投影](../backend/conversation-projection.md)
- [Web 消息端到端](../flows/e2e-web-message.md)
- [排障手册](../operations/troubleshooting.md)
