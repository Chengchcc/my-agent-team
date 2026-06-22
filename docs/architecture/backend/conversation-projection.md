---
id: backend.conversation-projection
title: 会话投影
status: current
owners: backend-runtime
last_verified_against_code: 2026-06-22
summary: "会话投影是后端 infrastructure 层，把已写进 ledger 的 assistant 消息 fan-out 到各端（Web 控制台、Lark IM 机器人）。message 事件经 onRunMessage → appendAssistantMessage 直写 ledger，broadcastMessage 是独立的 best-effort fan-out。buildPreloadedMessages 从 ledger 直接构建 Message[]。projectRunMessageToLedger、projectionChain、activeConversations 已删除。"
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

会话投影是后端的 infrastructure 层。它做两件事：把 assistant 消息 fan-out 到各端；从 ledger 给 Agent 构建上下文。

拿到这个 doc 需要先知道几个概念：[ledger](../conversation/ledger.md) 是对话的 canonical store；[RunSupervisor](./run-supervisor.md) 管运行生命周期；[EventLog](./event-log.md) 存 execution detail；`forkRun` 是 [conversation service](../conversation/conversation-and-members.md) 里触发 Agent 运行的 closure；`reflect` 是 Agent 自我反思的分叉运行模式；`issue:` 线程是 [Issue 工作流](../foundations/issue.md)的执行上下文，和对话线程隔离；SSE 是 Server-Sent Events，服务端推送协议。

会话投影以前负责"产生事实"——assistant 消息先落 event_log，再经 `projectRunMessageToLedger` 派生进 ledger。这条路已经拆了。现在：

- assistant 消息直写 ledger（`appendAssistantMessage`）
- fan-out 是独立 fire-and-forget
- `buildPreloadedMessages` 从 ledger 直接读，不经过 `projection_messages`

删掉的旧概念：`projectRunMessageToLedger`、`projectionChain`、`activeConversations`。

## onRunMessage：直写 ledger

assistant 消息在 `supervisor.onRunMessage` 回调里直接写 ledger，在 EventLog 之前：

```ts
// main.ts
supervisor.onRunMessage(async (threadId, runId, revision, kind) => {
  if (kind === "reflect") return;
  if (threadId.startsWith("issue:")) return;  // M18：issue 线程跳过
  const cid = parseThreadId(threadId).conversationId;
  const senderMemberId = parseThreadId(threadId).memberId || threadId;

  // 直写 ledger（critical）
  const seq = await conv.convSvc.appendAssistantMessage({
    conversationId: cid, senderMemberId, runId, revision,
  });

  // 更新 accumulator
  const acc = getOrCreateAccumulator(runId, senderMemberId);
  if (revision.role === "assistant") {
    acc.latestAssistantRevision = { ...revision, conversationId: cid };
    if (isTerminalMessageState(revision.state)) { /* @mention 扫描 */ }
  }

  // fan-out 到前端（best-effort, fire-and-forget）
  void conv.convSvc.broadcastMessage(entry, { excludeMemberId: senderMemberId }).catch(...);
});
```

## buildPreloadedMessages：给 Agent 构建上下文

在 `forkRun` 里调，从 ledger 直接读，产出 `Message[]`。不走 `projection_messages`。

```ts
// conv-svc-factory.ts
const preloadedMessages = buildPreloadedMessages(convPort, ctx.conversationId, ctx.agentMemberId);
const { attemptId } = await supervisor.startMainRun(runId, threadId, spec, {
  preloadedMessages,
  ...
});
```

## Supervisor 事件分流

```ts
case "event": {
  if (event.type === "message" && this.#onRunMessage.length > 0) {
    // message → onRunMessage（critical, awaited）
    for (const fn of this.#onRunMessage) await fn(threadId, runId, event.payload, kind);
    // onRunEvent fan-out（best-effort）
    for (const fn of this.#onRunEvent) void Promise.resolve(fn(...)).catch(...);
  } else {
    // 非 message → EventLog（critical） + onRunEvent（best-effort）
    await this.#opts.eventLog.append(threadId, runId, event);
    for (const fn of this.#onRunEvent) void Promise.resolve(fn(...)).catch(...);
  }
}
```

## onRunComplete：terminal 写入

分三层一致性：

```ts
export async function onRunComplete(...) {
  if (opsStore.getRunOrigin(runId)?.issueId) { clearAccumulator(runId); return; }

  const acc = runAccumulators.get(runId);
  try {
    // Phase 1 (CRITICAL): terminal revision write + broadcast
    const baseRev = acc?.latestAssistantRevision ?? findLatestAssistantRevision(convPort, cid, runId);
    // ... write terminal to ledger ...
  } catch (err) {
    throw err;
  } finally {
    // Phase 2 (CRITICAL): always release lock
    convSvc.completeRun(cid, threadId, runId);
  }
  // Phase 3 (BEST-EFFORT): todo + @mentions fire-and-forget
}
```

## 关键数据结构

```ts
interface RunAccumulator {
  senderMemberId: string;
  mentionedMemberIds: Set<string>;
  lastTodoUpdate: { todos: unknown } | null;
  latestAssistantRevision: MessageRevision | null;
}
```

LedgerEntry：
```ts
{
  seq: number, conversationId: string, senderMemberId: string,
  addressedTo: string[],
  kind: "message",
  content: string,   // MessageRevision JSON
  ts: number,
  runId?: string
}
```

## 不变量

1. assistant 消息和人类消息经同一 `appendLedgerEntry` 底层入口。
2. ledger 是对话 canonical store；event_log 只含 execution detail。
3. `buildPreloadedMessages` 从 ledger 直接构建 Message[]，不经过 `projection_messages`。
4. Runner 不直接写 ledger。
5. reflect 跑 `kind === "reflect"` 过滤；issue 跑 `threadId.startsWith("issue:")` 过滤。
6. terminal 写入不依赖进程内存；restart 后从 ledger 重建 base revision。
7. todo 和 @mention 是 best-effort，不阻塞 terminal 写入或锁释放。

## 失败模式

**直写失败**：`appendAssistantMessage` 是 critical path，失败上抛，run 标 error。

**fan-out 失败不影响事实**：broadcast 失败只记日志。ledger 已持久化，重连从 SSE 重放。

**restart 后 terminal 丢失**：`onRunComplete` 从 ledger 扫同 runId 的最新 assistant revision 做 base，不依赖内存。

## 关联页面

- [事实与投影](../foundations/facts-and-projections.md)
- [EventLog](./event-log.md)
- [RunSupervisor](./run-supervisor.md)
- [对话账本](../conversation/ledger.md)
- [Web 端](../surfaces/web.md)
- [Lark 适配器](../surfaces/lark-adapter.md)
