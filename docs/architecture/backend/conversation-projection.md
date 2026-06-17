---
id: backend.conversation-projection
title: 会话投影
status: current
owners: backend-runtime
last_verified_against_code: 2026-06-17
summary: "会话投影的角色已从「产生事实」变为「分发已成事实」。assistant 消息由 Supervisor 经 `onRunMessage` 回调直写账本（与人类消息同一条 `appendAndBroadcast` 入口）。投影桥现在只做 best-effort 扇出：broadcast 给前端、ops 记录——全 fire-and-forget。`projectRunMessageToLedger` 已删除；`projectionChain` 已删除；`activeConversations` 已删除。"
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

会话投影的角色已从「产生事实」变为「分发已成事实」。assistant 消息由 Supervisor 经 `onRunMessage` 回调直写账本（与人类消息同一条 `appendAndBroadcast` 入口）。投影桥现在只做 best-effort 扇出：broadcast 给前端、ops 记录——全 fire-and-forget。

## 这页解决什么问题

Agent 的产出最先诞生在一次「运行」里，而运行不等于「对话」。此前 assistant 消息先落 `event_log`，再经投影桥（`projectRunMessageToLedger`）派生进账本——一条业务事实有两个权威载体。拆掉了旧结构：assistant 消息现在与人类消息经同一入口直写账本，投影桥降级为纯扇出。

这页解释：
- 为什么旧的「event_log → 投影 → 账本」路径是反模式
- assistant 消息的直写路径是什么样的
- 投影桥现在只做什么（best-effort fan-out）
- `onRunComplete` 的 terminal 写入如何工作
- 不再存在的概念：`projectRunMessageToLedger`、`projectionChain`、`activeConversations`

## 现在代码怎么做的

### 直写路径（直写路径）

assistant 消息通过 `supervisor.onRunMessage` 回调直接写入账本——在 EventLog append 之前：

```ts
// main.ts
supervisor.onRunMessage(async (threadId, runId, revision, kind) => {
  if (kind === "reflect") return;
  const cid = parseThreadId(threadId).conversationId;
  const senderMemberId = parseThreadId(threadId).memberId || threadId;

  // 直写账本（critical，与 postMessage 同一条入口）
  const seq = await conv.convSvc.appendAssistantMessage({
    conversationId: cid, senderMemberId, runId, revision,
  });

  // 更新 accumulator（供 onRunComplete 用）
  const acc = getOrCreateAccumulator(runId, senderMemberId);
  if (revision.role === "assistant") {
    acc.latestAssistantRevision = { ...revision, conversationId: cid };
    // @mention 扫描仅终端修订（不再每条 streaming revision 跑正则）
    if (isTerminalMessageState(revision.state)) { /* ... */ }
  }

  // 扇出给前端（best-effort, fire-and-forget）
  void conv.convSvc.broadcastMessage(entry, { excludeMemberId: senderMemberId }).catch(...);
});
```

`appendAssistantMessage` 在 `conversation/service.ts`：

```ts
async appendAssistantMessage(input: {
  conversationId: string; senderMemberId: string; runId: string; revision: MessageRevision;
}): Promise<number> {
  const stamped: MessageRevision = { ...input.revision, conversationId: input.conversationId, runId: input.runId };
  const serialized = serializeMessageRevision(stamped);
  return port.appendLedgerEntry({ conversationId, senderMemberId, addressedTo: [], kind: "message", content: serialized, ts: Date.now(), runId });
}
```

### Supervisor 侧（直写路径）

`case "event"` 分支现在按事件类型分流：

```ts
case "event": {
  if (event.type === "message" && this.#onRunMessage.length > 0) {
    // 消息事件 → onRunMessage（critical, awaited）
    for (const fn of this.#onRunMessage) await fn(threadId, runId, event.payload, kind);
    // onRunEvent 仅用于 fan-out（best-effort, fire-and-forget）
    for (const fn of this.#onRunEvent) void Promise.resolve(fn(...)).catch(...);
  } else {
    // 非消息事件 → EventLog（critical, throws） + onRunEvent（best-effort）
    await this.#opts.eventLog.append(threadId, runId, event);
    for (const fn of this.#onRunEvent) void Promise.resolve(fn(...)).catch(...);
  }
}
```

### onRunComplete（三段拆分）

`onRunComplete` 现在分三个一致性等级：

```ts
export async function onRunComplete(...) {
  const acc = runAccumulators.get(runId);
  try {
    // Phase 1 (CRITICAL): terminal revision write + broadcast
    const baseRev = acc?.latestAssistantRevision ?? findLatestAssistantRevision(convPort, cid, runId);
    // ... write terminal ...
  } catch (err) {
    console.error(...);
    throw err; // critical failure propagated
  } finally {
    // Phase 2 (CRITICAL): always release lock
    convSvc.completeRun(cid, threadId, runId);
  }
  // Phase 3 (BEST-EFFORT): todo + @mentions fire-and-forget
  if (acc) {
    clearAccumulator(runId);
    if (acc.lastTodoUpdate) void convSvc.appendTodo(...).catch(...);
    if (acc.mentionedMemberIds.size > 0) void convSvc.triggerMentionedAgents(...).catch(...);
  }
}
```

## 输入与输出

| 方向 | 项目 | 说明 |
|------|------|------|
| 输入 | threadId, runId, revision, kind | 来自 `onRunMessage` 回调（直写路径） |
| 输入 | threadId, runId, status | 来自 `onRunComplete` 回调（terminal 写入） |
| 输出 | 账本条目 | conversation_ledger，经 `appendAssistantMessage` 直写 |
| 输出 | broadcast | best-effort 扇出给前端 SSE 订阅者 |

## 关键数据结构

### RunAccumulator

`projectionChain` 已删除（不再有串行投影写入）。`latestAssistantRevision` 现在由 `onRunMessage` 直接更新。

```ts
interface RunAccumulator {
  senderMemberId: string;
  mentionedMemberIds: Set<string>;
  lastTodoUpdate: { todos: unknown } | null;
  latestAssistantRevision: MessageRevision | null;
}
```

### 账本条目字段

```ts
{
  seq: number, conversationId: string, senderMemberId: string,
  addressedTo: string[],
  kind: "message",
  content: string,   // MessageRevision 的 JSON
  ts: number,
  runId?: string     // 属领域本体字段，在 packages/conversation 的 LedgerEntry zod 中定义
}
```

## 不变量

1. assistant 消息与人类消息经同一入口（`appendLedgerEntry`）写入账本（直写路径）。
2. 账本为对话消息唯一事实来源；`event_log` 只含执行细节（tool_start/tool_end/text_delta）。
3. Runner 不直接写对话账本。
4. Web/飞书不独立把运行产出当对话历史持久化。
5. reflect 运行通过 `kind === "reflect"` 过滤。
6. terminal 写入不依赖进程内存；重启后从 ledger 重建 base revision（M17.4）。
7. todo 和 @mention 触发为 best-effort，不阻塞 terminal 写入或锁释放（P3）。

## 失败模式

### assistant 消息直写失败

`appendAssistantMessage` 是 critical——失败上抛，运行标记为 error。不再有静默丢失的「EventLog 成了但投影没成」窗口。

### 扇出失败不影响事实

broadcast 失败只记日志，账本已持久化。前端断线重连从 SSE 重放即可恢复。

### 进程重启 terminal 丢失

terminal 去内存化仍然有效：`onRunComplete` 从 ledger 扫描同 runId 的最新 assistant revision 作为 base。直写路径强化了这个保证——账本在 terminal 之前就有完整的 streaming 历史。

## 关联页面

- [事实与投影](../foundations/facts-and-projections.md)
- [EventLog](./event-log.md)
- [RunSupervisor](./run-supervisor.md)
- [对话账本](../conversation/ledger.md)
- [Web 端](../surfaces/web.md)
- [飞书适配器](../surfaces/lark-adapter.md)
- [Message 领域类型](../foundations/message.md)
