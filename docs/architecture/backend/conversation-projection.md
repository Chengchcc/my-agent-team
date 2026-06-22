---
id: backend.conversation-projection
title: 会话投影
status: current
owners: backend-runtime
last_verified_against_code: 2026-06-22
summary: "会话投影的角色已从「产生事实」变为「分发已成事实」。assistant 消息由 Supervisor 经 onRunMessage → appendAssistantMessage 直写账本底层（appendLedgerEntry），广播是独立的 best-effort 扇出。buildPreloadedMessages 从账本直接构建 Message[] 给 forkRun，不走 projection_messages。projectRunMessageToLedger、projectionChain、activeConversations 已删除。"
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

会话投影的角色已从「产生事实」变为「分发已成事实」。assistant 消息由 Supervisor 经 `onRunMessage` → `appendAssistantMessage` 直写账本（底层是 `appendLedgerEntry`），广播 `broadcastMessage` 是独立的 best-effort 扇出。`buildPreloadedMessages` 从账本直接构建 Message[] 给 forkRun 的 `preloadedMessages`。

## 这页解决什么问题

Agent 的产出最先诞生在一次「运行」里，而运行不等于「对话」。此前 assistant 消息先落 `event_log`，再经投影桥（`projectRunMessageToLedger`）派生进账本——一条业务事实有两个权威载体。拆掉了旧结构：

- assistant 消息现在直写账本（`appendAssistantMessage`）。
- 广播扇出是独立的 fire-and-forget（与写入解耦）。
- `buildPreloadedMessages` 从账本直接读——preloadedMessages 不再经过 `projection_messages`。
- 不再存在的概念：`projectRunMessageToLedger`、`projectionChain`、`activeConversations`。

## 现在代码怎么做的

### 直写路径（onRunMessage → appendAssistantMessage）

assistant 消息通过 `supervisor.onRunMessage` 回调直接写入账本——在 EventLog append 之前：

```ts
// main.ts
supervisor.onRunMessage(async (threadId, runId, revision, kind) => {
  if (kind === "reflect") return;
  if (threadId.startsWith("issue:")) return;  // M18: issue 线程跳过会话投影
  const cid = parseThreadId(threadId).conversationId;
  const senderMemberId = parseThreadId(threadId).memberId || threadId;

  // 直写账本（critical，底层 appendLedgerEntry）
  const seq = await conv.convSvc.appendAssistantMessage({
    conversationId: cid, senderMemberId, runId, revision,
  });

  // 更新 accumulator（供 onRunComplete 用）
  const acc = getOrCreateAccumulator(runId, senderMemberId);
  if (revision.role === "assistant") {
    acc.latestAssistantRevision = { ...revision, conversationId: cid };
    if (isTerminalMessageState(revision.state)) { /* @mention 扫描 */ }
  }

  // 扇出给前端（best-effort, fire-and-forget）
  void conv.convSvc.broadcastMessage(entry, { excludeMemberId: senderMemberId }).catch(...);
});
```

### buildPreloadedMessages（preloadedMessages 构建）

在 `forkRun` 闭包中调用，从账本直接构建 Message[]。绕过 `projection_messages` 中间表。

```ts
// conv-svc-factory.ts
const preloadedMessages = buildPreloadedMessages(convPort, ctx.conversationId, ctx.agentMemberId);
const { attemptId } = await supervisor.startMainRun(runId, threadId, spec, {
  preloadedMessages,
  ...
});
```

### Supervisor 侧（事件分流）

```ts
case "event": {
  if (event.type === "message" && this.#onRunMessage.length > 0) {
    // 消息事件 → onRunMessage（critical, awaited）
    for (const fn of this.#onRunMessage) await fn(threadId, runId, event.payload, kind);
    // onRunEvent fan-out（best-effort）
    for (const fn of this.#onRunEvent) void Promise.resolve(fn(...)).catch(...);
  } else {
    // 非消息事件 → EventLog（critical） + onRunEvent（best-effort）
    await this.#opts.eventLog.append(threadId, runId, event);
    for (const fn of this.#onRunEvent) void Promise.resolve(fn(...)).catch(...);
  }
}
```

### onRunComplete（三段拆分）

```ts
export async function onRunComplete(...) {
  // M18.2: issue-driven runs → skip projection
  if (opsStore.getRunOrigin(runId)?.issueId) { clearAccumulator(runId); return; }

  const acc = runAccumulators.get(runId);
  try {
    // Phase 1 (CRITICAL): terminal revision write + broadcast
    const baseRev = acc?.latestAssistantRevision ?? findLatestAssistantRevision(convPort, cid, runId);
    // ... write terminal to ledger ...
  } catch (err) {
    throw err;  // critical failure propagated
  } finally {
    // Phase 2 (CRITICAL): always release lock
    convSvc.completeRun(cid, threadId, runId);
  }
  // Phase 3 (BEST-EFFORT): todo + @mentions fire-and-forget
}
```

## 输入与输出

| 方向 | 项目 | 说明 |
|------|------|------|
| 输入 | threadId, runId, revision, kind | 来自 `onRunMessage` 回调（直写路径） |
| 输入 | threadId, runId, status | 来自 `onRunComplete` 回调（terminal 写入） |
| 输出 | 账本条目 | conversation_ledger，经 `appendAssistantMessage` → `appendLedgerEntry` |
| 输出 | preloadedMessages | `buildPreloadedMessages` 从账本直接构建 Message[] |
| 输出 | broadcast | best-effort 扇出给前端 SSE 订阅者 |

## 关键数据结构

### RunAccumulator

```ts
interface RunAccumulator {
  senderMemberId: string;
  mentionedMemberIds: Set<string>;
  lastTodoUpdate: { todos: unknown } | null;
  latestAssistantRevision: MessageRevision | null;
}
```

### 账本条目（LedgerEntry）

```ts
{
  seq: number, conversationId: string, senderMemberId: string,
  addressedTo: string[],
  kind: "message",
  content: string,   // MessageRevision 的 JSON 序列化
  ts: number,
  runId?: string     // assistant 消息携带，人类/系统不填
}
```

## 不变量

1. assistant 消息与人类消息经同一底层 `appendLedgerEntry` 写入账本。
2. 账本为对话消息唯一事实容器；`event_log` 只含执行细节。
3. `buildPreloadedMessages` 从账本直接构建 Message[]，不经过 `projection_messages`。
4. Runner 不直接写对话账本。
5. reflect 运行通过 `kind === "reflect"` 过滤；issue 运行通过 `threadId.startsWith("issue:")` 过滤。
6. terminal 写入不依赖进程内存；重启后从 ledger 重建 base revision。
7. todo 和 @mention 触发为 best-effort（P3），不阻塞 terminal 写入或锁释放。

## 失败模式

### assistant 消息直写失败

`appendAssistantMessage` 是 critical——失败上抛，运行标记为 error。不再有「EventLog 成了但投影没成」的静默丢失窗口。

### 扇出失败不影响事实

broadcast 失败只记日志，账本已持久化。前端断线重连从 SSE 重放即可恢复。

### 进程重启 terminal 丢失

terminal 去内存化仍然有效：`onRunComplete` 从 ledger 扫描同 runId 的最新 assistant revision 作为 base。

## 关联页面

- [事实与投影](../foundations/facts-and-projections.md)
- [EventLog](./event-log.md)
- [RunSupervisor](./run-supervisor.md)
- [对话账本](../conversation/ledger.md)
- [Web 端](../surfaces/web.md)
- [飞书适配器](../surfaces/lark-adapter.md)
