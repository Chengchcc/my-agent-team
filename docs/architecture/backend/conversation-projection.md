---
id: backend.conversation-projection
title: 会话投影
status: current
owners: backend-runtime
last_verified_against_code: 2026-06-17
summary: "会话投影是后端独占的那座桥：它把框架产出的 `MessageRevision` 信封（state=streaming/done/error）转成对话账本里一条带 messageId 的条目。增量投影由 `apps/backend/src/features/conversation/projection.ts` 的 `projectRunMessageToLedger` 实现，注册成 `RunSupervisor` 的 `onRunEvent` 监听器，通过 `projectionChain` 串行保证同 messageId 的修订有序；`onRunComplete` await projectionChain 后写入最终 done/error 修订。M17.4: terminal 写入不再依赖进程内存（RunAccumulator Map），重启后从 ledger 重建 base revision。"
depends_on:
  - backend.event-log
  - backend.run-supervisor
  - conversation.ledger
used_by:
  - surfaces.web
  - surfaces.lark-adapter
  - flows.e2e-web-message
  - flows.e2e-lark-message
  - operations.troubleshooting
---

# 会话投影

会话投影是后端独占的那座桥：它接收框架（L2 runtime）已组装好的 `MessageRevision` 修订信封，加上 `conversationId` 归属戳，序列化后写入对话账本。同一个逻辑消息的多次修订（流式中间态→最终 done/error）共享相同的 `messageId`，消费者按 `messageId` upsert 进同一个气泡/卡片。增量投影通过 `projectionChain` 串行写入；`onRunComplete` await projectionChain 后写入最终 done/error 修订。

## 这页解决什么问题

Agent 的产出最先诞生在一次「运行」里，而运行不等于「对话」。如果让每个消费者（Web、飞书、完成钩子）各自把产出往账本里写，结果必然是重复和各端行为不一致。会话投影把这件事收敛成一个唯一决策点：

- 哪些运行事件该变成对话消息？
- reflect 运行如何通过 `kind` 字段被过滤（不再靠 threadId 字符串前缀）？
- 同一条逻辑消息在流式过程中会发多次修订——怎么按 `messageId` 串行写入？
- 这条消息算哪个成员发的（通过 `parseThreadId` 反解）？
- 落库的 `MessageRevision` 信封长什么形状？
- 各端怎么按 `messageId` upsert 进同一个气泡/卡片？
- 进程重启后，terminal 写入如何从 ledger 重建 base revision（不再依赖 RunAccumulator 内存态）？

## 现在代码怎么做的

投影是**增量**的。它挂在 `RunSupervisor` 的事件路径上，对每条已落库的 `message` 事件触发一次。注册处（`main.ts`）只放行 `type==="message"` 的事件，并将 `kind`（run 类型，由 supervisor 提供）透传给投影函数：

```ts
supervisor.onRunEvent((threadId, runId, event, kind) => {
  if (event.type !== "message") return;
  const revision = event.payload;

  // 通过 projectionChain 串行：同 messageId 的修订有序
  const senderMemberId = parseThreadId(threadId).memberId || threadId;
  const acc = getOrCreateAccumulator(runId, senderMemberId);
  acc.projectionChain = acc.projectionChain
    .then(() => projectRunMessageToLedger(threadId, runId, revision, activeConversations, convPort, convSvc, kind))
    .catch((err) => { console.error(err); });
});
```

`projectRunMessageToLedger` 的真实主体（M17.4 版）在 `apps/backend/src/features/conversation/projection.ts`：

```ts
export async function projectRunMessageToLedger(
  threadId: string,
  runId: string,
  revision: MessageRevision,
  activeConversations: Set<string>,
  convPort: ConversationPort,
  convSvc: ConversationService,
  kind?: string,   // M17.4: "reflect" runs skip projection
): Promise<void> {
  if (kind === "reflect") return;
  if (revision.role !== "assistant" && revision.role !== "user") return;

  const hasContent = (revision.text?.length ?? 0) > 0 || (revision.blocks?.length ?? 0) > 0 || (revision.tools?.length ?? 0) > 0;
  if (!hasContent) return;

  const cid = [...activeConversations].find((c) => threadId.startsWith(`${c}:`));
  if (!cid) return;
  const senderMemberId = parseThreadId(threadId).memberId || threadId;

  const acc = getOrCreateAccumulator(runId, senderMemberId);
  const stamped: MessageRevision = { ...revision, conversationId: cid };

  const ts = Date.now();
  const serialized = serializeMessageRevision(stamped);
  if (convPort.hasLedgerContent?.(runId, serialized)) return;

  if (stamped.role === "assistant" && kind !== "reflect") {
    acc.latestAssistantRevision = stamped;
  }

  const seq = convPort.appendLedgerEntry({
    conversationId: cid, senderMemberId, addressedTo: [],
    kind: "message", content: serialized, ts, runId,
  });
  await convSvc.broadcastMessage(
    { seq, conversationId: cid, senderMemberId, addressedTo: [], kind: "message", content: serialized, ts },
    { excludeMemberId: senderMemberId },
  );
}
```

投影在 `RunSupervisor` 的 `"event"` 分支里被调用，**在 `eventLog.append(...)` 成功之后**，通过 `projectionChain` Promise 链串行，保证同一 `messageId` 的 `streaming → done/error` 修订顺序正确。监听器报错只记日志，不中断运行。

`onRunComplete` 的收尾顺序：**await projectionChain** → 从 ledger 或 accumulator 重建 base revision → 写入最终 done/error 修订 → 放掉对话锁（`convSvc.completeRun`）→ 把最后一次 `todo_update` 快照写进账本（`convSvc.appendTodo`）→ 消费运行期间累进的 @提及集合并触发对应 Agent（`convSvc.triggerMentionedAgents`）。

**M17.4 terminal 去内存化**：`onRunComplete` 写 terminal 修订时，优先从 `RunAccumulator.latestAssistantRevision`（内存）取 base revision；若进程已重启导致 accumulator 为空，fallback 到 ledger 扫描（`findLatestAssistantRevision`），读取同 runId 的最新已持久化 assistant revision 作为 base。这保证了重启后 Message 仍能正确关闭到 terminal 态。

@提及的收集是增量的：每次 `onRunEvent` tick 遇到 `role === "assistant"` 的消息事件，就从 revision 的 blocks/text 中提取 `@displayName` 或 `@memberId`，与当前对话的 agent 成员名册匹配，命中的 memberId 写入 `RunAccumulator.mentionedMemberIds`。`onRunComplete` 在写入 done/error 修订后直接消费该累加器，无需第二次 EventLog 扫描。

## 输入

| 输入 | 来源 | 含义 |
|---|---|---|
| threadId | RunSupervisor 事件上下文 | `conversationId:memberId`，由 `parseThreadId` 反解 |
| runId | 同上 | 标识产出这条消息的运行 |
| revision | AgentEvent message.payload | 框架已组装的 `MessageRevision`，含 messageId/state/role/blocks/tools |
| kind | RunSupervisor 事件上下文 | M17.4: "main" 或 "reflect"，用于替代 threadId.startsWith("reflect:") |

## 输出

| 输出 | 去向 | 含义 |
|---|---|---|
| 账本条目 | conversation_ledger | 持久、对话可见的消息 |
| runId 信封 | 账本 content | 让端能把最终文本关联回某次运行 |
| 线程投影更新 | projection_messages | M17.4: 表名归属 projection（不再借用 checkpointer 的表名） |

## 投影算法（与代码一一对应）

1. `kind === "reflect"` → 跳过（reflect 运行与主投影物理隔离）。
2. `revision.role` 不是 `assistant` 也不是 `user` → 跳过。
3. 无内容（无 text、无 blocks、无 tools）→ 跳过。
4. 在 `activeConversations` 里找 `threadId.startsWith(cid + ":")` 得到 `cid`；找不到就返回。
5. `senderMemberId` = `parseThreadId(threadId).memberId`（M17.4: 统一解析规则，与 `deriveThreadId` 互逆）。
6. 给 revision 加上 `conversationId` 归属戳。
7. `serializeMessageRevision` 序列化（经 zod 校验）。
8. 去重：`convPort.hasLedgerContent?.(runId, serialized)` 已存在则跳过。
9. 更新 `RunAccumulator.latestAssistantRevision` 供 `onRunComplete` 写最终修订。
10. 以 `kind="message"`、`addressedTo: []`、`runId` 追加账本条目。
11. `broadcastMessage` 广播，更新各成员的线程投影——调用时传 `{ excludeMemberId: senderMemberId }`。

## 关键数据结构

### MessageRevision 信封（M17 unified）

`MessageRevision` 是 `@my-agent-team/message` 的 canonical 领域类型，对所有层一致：

```ts
{
  messageId: string,           // run:<runId>:assistant:<ordinal>
  state: "streaming" | "done" | "error" | "waiting",
  role: "assistant" | "user",
  text?: string | null,
  blocks?: ContentBlock[] | null,
  tools?: MessageToolState[] | null,
  runId?: string | null,
  conversationId?: string | null,
  visibility?: "internal" | "conversation" | null,
  updatedAt: number,
  error?: { code?: string; message: string } | null,
}
```

同一个逻辑 assistant 消息的所有修订共享相同的 `messageId`（由 `assistantMessageId(runId, ordinal)` 生成）。Web/飞书端按 `messageId` upsert：同一 `messageId` 的新修订替换旧修订，保证一个气泡/卡片里始终只有最新内容。

### projectionChain 串行

```ts
interface RunAccumulator {
  senderMemberId: string;
  mentionedMemberIds: Set<string>;
  lastTodoUpdate: { todos: unknown } | null;
  latestAssistantRevision: MessageRevision | null;  // M17.4: 优化缓存，非唯一来源
  projectionChain: Promise<void>;
  assistantOrdinal: number;  // M17.4: 同 run 多段 assistant 消息序列号
}
```

每次 `onRunEvent` 调用把投影串在 `projectionChain` 后：`acc.projectionChain = acc.projectionChain.then(...)`。`onRunComplete` 先 `await acc.projectionChain`，再写入最终 done/error 修订——确保终端修订一定排在所有 streaming 修订之后。

### 账本条目字段

```ts
{
  seq: number,
  conversationId: string,
  senderMemberId: string,
  addressedTo: string[],       // 投影写入时恒为 []
  kind: 'message',
  content: string,             // MessageRevision 的 JSON 字符串
  ts: number,
  runId?: string               // M17 新增：关联到运行
}
```

## 不变量

1. 一条逻辑运行消息对应一个 `messageId`，可有多条修订（streaming → done/error），端按 `messageId` upsert。
2. Runner 不直接写对话账本。
3. Web/飞书不独立把运行产出当对话历史持久化。
4. reflect 运行通过 `kind === "reflect"` 过滤（M17.4: 不再靠 threadId 字符串前缀）。
5. 投影失败必须可观测、可重试。
6. `threadId` 解析统一走 `parseThreadId`（与 `deriveThreadId` 互逆）；全仓无裸 `split(":")`。
7. `assistantMessageId` 接受 ordinal 参数，同一 run 可产出多条 assistant message 不互相覆盖。
8. terminal 写入不依赖进程内存；重启后从 ledger 重建 base revision。

## 失败模式

### 投影修订乱序

同一 `messageId` 的 streaming/done/error 修订通过 `projectionChain` 串行保证顺序。若绕过 chain 直接写入（已通过代码设计杜绝），端可能看到 done 后再看到 streaming 修订，导致草稿残留。

### Web/飞书按 messageId upsert 竞态

消费者在收到 done/error 修订后若因网络延迟又收到旧的 streaming 修订（`state` 字段非终态），需忽略——端应按 messageId 保持「终态优先」语义。

### 发送者检查点污染

已通过 `broadcastMessage(entry, { excludeMemberId: senderMemberId })` 解决。

### 账本重复行

`appendLedgerEntry` 前通过 `convPort.hasLedgerContent?.(runId, serialized)` 去重。

### 进程重启 terminal 丢失

M17.4 修复：`onRunComplete` 从 ledger 扫描同 runId 的最新 assistant revision 作为 base（`findLatestAssistantRevision`），即使 `RunAccumulator` Map 已因重启清空，也能写出正确的 terminal 修订。

## 关联页面

- [事实与投影](../foundations/facts-and-projections.md)
- [EventLog](./event-log.md)
- [RunSupervisor](./run-supervisor.md)
- [对话账本](../conversation/ledger.md)
- [Web 端](../surfaces/web.md)
- [飞书适配器](../surfaces/lark-adapter.md)
- [Message 领域类型](../foundations/message.md)
