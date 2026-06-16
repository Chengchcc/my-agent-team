---
id: surfaces.web
title: Web 端
status: current
owners: architecture
last_verified_against_code: 2026-06-16
summary: "Web 端是浏览器里的对话与运行界面。它同时消费两条 SSE——会话/账本流和运行流——在 conversation-reducer 里把乐观消息、实时草稿、运行阶段、todo 合并成一份状态。它的核心难点是「临时草稿」和「持久账本消息」之间的交接。"
depends_on:
  - conversation.ledger
  - backend.conversation-projection
used_by:
  - flows.e2e-web-message
  - operations.troubleshooting
---

# Web 端

Web 端是浏览器里的对话与运行界面。它同时消费两条 SSE——会话/账本流和运行流——在 conversation-reducer 里把乐观消息、实时草稿、运行阶段、todo 合并成一份状态。它的核心难点是「临时草稿」和「持久账本消息」之间的交接。

## 这页解决什么问题

用户既要看到持久的对话历史，又要看到进行中的运行产出。Web 必须对账好这几样东西：乐观「人」消息、账本回声、运行文本 delta、工具开始/结束指示、中断提示、todo 快照、最终被投影进来的 assistant 消息。

## 状态形状（ConvState）

```ts
{
  viewerMemberId: string,
  roster: Record<string, SenderRef>,
  messages: UiMessage[],
  draft: { runId, agentMemberId, sender, text, tools } | null,
  run: { id: string|null, phase: RunPhase, agentMemberId: string|null },
  ledgerConn: "connecting"|"open"|"reconnecting"|"closed",
  pendingInterrupt: { id, name, input } | null,
  error: string | null,
  optimisticSeq: number,
  triggerMode: "auto" | "mention",
  todos: Array<{ step, status: "pending"|"in_progress"|"done" }>
}
RunPhase = "idle" | "running" | "interrupted" | "done" | "error"
```

Action 联合（精确）：`bootstrap`、`ledger/member`、`ledger/message`、`send`、`run/started`、`stream/delta`、`stream/toolStart`、`stream/toolEnd`、`run/interrupted`、`run/error`、`run/done`、`run/completed`、`run/noop`、`ledger/conn`、`toggleTriggerMode`、`todo/update`。

## 两条 SSE 怎么合并

`useConversation` 开两个 EventSource：

1. **会话/账本 SSE** `/api/bff/conversations/:id/events`——事件 `message`、`member.*`、`todo`；按 `lastEventId` 去重；这是权威流。
2. **统一运行 SSE** `/api/bff/runs/:runId/events`（仅 `phase==="running"` 时开）——单个端点合并了临时 delta（`text_delta`/`tool_start`/`tool_end`）和持久事件（`done`/`interrupted`/`todo_update`），外加 `onerror` 兜底去 `getRun` 查终态。临时 delta 画 `draft`，持久事件驱动状态迁移。

合并思路：临时运行流画 `draft`，权威账本流写 `UiMessage` 并清掉草稿，完成「临时 → 持久」的交接。

## 草稿生命周期

- **创建**：`stream/delta` 第一段文本建草稿（仅当 `a.runId === draft?.runId` 才沿用旧文本/工具，否则清空重来）。`stream/toolStart` 在无草稿时也会用 `run.id`/`run.agentMemberId` 兜出一个最小草稿。
- **更新**：`toolStart` 往 `draft.tools` 加 `{id,name}`，`toolEnd` 按 id 移除。
- **清除**：`run/interrupted`、`run/error`、`run/done` 的中断/错误分支，以及 `ledger/message` 命中 `clearsDraft` 时。

`run/done` / `run/completed` 的正常分支**故意不清草稿**（防闪烁）：

```ts
case "run/done":
case "run/completed":
  if (s.run.phase === "interrupted" || s.run.phase === "error")
    return { ...s, draft: null };
  // 持久的 done 比账本写回早 ~500ms 到，这里清会闪
  return { ...s, run: { ...s.run, phase: "done" } };
```

## 已知闪烁：按 Agent 匹配而非按 runId

`ledger/message` 的清草稿条件是：

```ts
const clearsDraft =
  sender.memberId === s.viewerMemberId ||
  (s.draft !== null && a.senderMemberId === s.draft.agentMemberId);
```

它按「同一个 Agent」匹配，**不看 runId**。所以一条同 Agent 的**中途**账本消息（增量投影产生的非最终文本）也会清掉实时草稿，这正是闪烁的根因。`norm(c)` 会解信封包装（读 `{text}`/`{blocks}`，丢掉 runId），但 reducer 始终没拿 runId 来对账。

## 几个关键纯函数

- `upsertAuthoritative`：有同 id 就替换；否则对自己的消息替换最近一条乐观消息（`opt-` 前缀）；再否则追加。把权威 `s-${seq}` 与乐观回声对账。
- `isConclusionMessage`：字符串非空即为结论；块内容仅当「有非空 text 块且无 tool_use 块」才算结论——纯 tool_result 消息不是结论。
- `groupTurns`：把连续同 Agent 消息收成一个 `turn` 段，`conclusion` 取该段最后一条结论，其余进 `rounds`。

## Timeline 锚点

`Timeline` 调 `groupTurns`，`extractAnchors` 把锚点放在 `segmentSender(seg).kind === "human"` 的段上——**锚点按「人发言」边界**。Agent 的 `turn` 段经 `ReasoningTrace` 渲染、不带锚点。纯 Agent ↔ Agent 链以 sender-change 边界兜底，`isTurnStart` 在 `prevSender.memberId !== sender.memberId && prevSender.kind !== "system"` 时也视为 turn 起点。

## 失败模式

- 草稿闪烁：同 Agent 账本消息过早清草稿（上文）。
- 草稿残留：run done 了但最终账本消息没来。
- 缺推理：`reasoning_delta` 端到端是产生的（适配器从 thinking 块发出），但若产品不要推理，应连同上游一起去掉而非留着死事件。
- 轮询抖动：不稳定的 effect 依赖会重建 interval。

## 当前缺口

- 草稿生命周期应改为按 runId 感知。
- Web 需要一份成文的内容 schema（runId 信封 + 纯工具过滤约定）。

## 关联页面

- [对话账本](../conversation/ledger.md)
- [会话投影](../backend/conversation-projection.md)
- [Web 消息端到端](../flows/e2e-web-message.md)
- [排障手册](../operations/troubleshooting.md)
