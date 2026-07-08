# Steer / FollowUp 接线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** 接通 harness steer/followUp 到前端——运行中可发消息（steer + 可编辑排队区域），完成后可追加任务（followUp），不报 409。

**Spec:** `docs/superpowers/specs/2026-07-07-steer-followup-wiring-design.md`

---

## 代码事实

| 事实 | 位置 |
|------|------|
| `AgentSession.steer(text)` 运行中插入消息 | `harness/agent-session.ts:210` |
| `AgentSession.followUp(text)` 完成后追加 | `harness/agent-session.ts:218` |
| `queue_update` 事件含 `{ steering: string[], followUp: string[] }` | `agent-session.ts:96-100` |
| postMessage 遇 busy 抛 409 | `service.ts:208-209` |
| startAgentRun 在 conversation-compose.ts 创建 session | `conversation-compose.ts:139-189` |
| 前端 send() 调 postMessage，遇 onError dispatch send/error | `useConversation.ts:192-199` |
| Composer disabled={busy} 运行中禁用输入框 | `ConversationCanvas.tsx:300` |
| 前端没有消费 queue_update 事件 | grep 确认无匹配 |
| conversation service 不持有 session 引用 | service 通过 startAgentRun 回调间接创建 |

---

## Task 1: 后端 — activeSessions Map + postMessage steer/followUp

**Files:**
- Modify: `apps/backend/src/features/conversation/conversation-compose.ts`
- Modify: `apps/backend/src/features/conversation/service.ts`

- [ ] **Step 1: conversation-compose.ts 新增 activeSessions Map**

在 `createConversationFeature` 函数体内、`convSvc` 创建前：
```typescript
const activeSessions = new Map<string, {
  steer: (text: string) => void;
  followUp: (text: string) => void;
}>();
```

- [ ] **Step 2: startAgentRun 里注册 session 的 steer/followUp**

在 `session.prompt()` 之前（line 183 之前），注册：
```typescript
activeSessions.set(conversationId, {
  steer: (text: string) => {
    try { session.steer(text); } catch { /* not running — ignore */ }
  },
  followUp: (text: string) => {
    try { session.followUp(text); } catch { /* not initialized — ignore */ }
  },
});
```

- [ ] **Step 3: onRunComplete 回调里清除 activeSessions**

在 `supervisor.onRunComplete` 回调里（conversation-compose.ts 现有的 handleAssistantMessage 区域，或单独注册一个 onRunComplete），在 run 完成后清除：
```typescript
// 在 conversation feature 返回前，注册一个 onRunComplete 清理
// 或者在 startAgentRun 的 session.prompt() 的 finally 里清除
```

注意：`session.prompt()` 是 `void`（fire-and-forget），不能直接 await。需要在 supervisor 的 onRunComplete 回调里清除——但 conversation-compose 没有 supervisor 引用。

最简方案：把 activeSessions 传给 conversation service，在 `completeRun`（service.ts:428）里清除。`completeRun` 在 run-accumulator 的 finally 里被调用。

- [ ] **Step 4: service.ts postMessage busy 时 steer 而非抛 409**

ConversationServiceDeps 加 `activeSessions` 参数：
```typescript
export interface ConversationServiceDeps {
  // ... 现有字段 ...
  activeSessions: Map<string, {
    steer: (text: string) => void;
    followUp: (text: string) => void;
  }>;
}
```

postMessage 里（service.ts:208-210）改为：
```typescript
if (lock.isActive(input.conversationId)) {
  const active = deps.activeSessions.get(input.conversationId);
  if (active) {
    // 消息写入 ledger（让用户看到自己发的消息）
    const userText = typeof input.content === "string" ? input.content : "";
    // appendAndBroadcast 已在下面执行（line 234），这里提前 return 前先执行
    // 实际上需要把 appendAndBroadcast 移到 busy 检查之前，或者在这里单独 append
    // 最简：不 append（steer 消息不进 ledger，只进 steering queue）
    // 但用户需要看到自己发的消息——所以还是要 append
    active.steer(userText);
    return { seq: 0, triggeredRuns: [] };
  }
  throw new ConversationBusyError(input.conversationId);
}
```

注意：需要把 appendAndBroadcast 逻辑提到 busy 检查之前，或者在 steer 分支里也 append。最简：busy 检查前先 append 消息，然后 busy 时 steer，非 busy 时正常 fork。

- [ ] **Step 5: service.ts postMessage 非 busy 时优先 followUp**

在非 busy 分支、`forkAgentRuns` 之前：
```typescript
const active = deps.activeSessions.get(input.conversationId);
if (active && targets.length > 0 && !hopCapped) {
  const userText = typeof input.content === "string" ? input.content : "";
  active.followUp(userText);
  return { seq, triggeredRuns: [] };
}
```

- [ ] **Step 6: completeRun 里清除 activeSessions**

```typescript
completeRun(conversationId: string, _spanId: string): void {
  lock.releaseOne(conversationId);
  deps.activeSessions.delete(conversationId);
},
```

- [ ] **Step 7: Commit**

---

## Task 2: 前端 — useConversation 加排队状态 + queue_update 事件

**Files:**
- Modify: `apps/web/src/hooks/useConversation.ts`
- Modify: `apps/web/src/lib/conversation-reducer.ts`

- [ ] **Step 1: conversation-reducer.ts 加排队状态**

ConvState 加 `queuedMessages: string[]`。新增 reducer action：
- `queue/update` — 从 queue_update 事件更新排队消息
- `queue/add` — 乐观追加一条排队消息
- `queue/edit` — 编辑排队消息
- `queue/remove` — 撤回排队消息

- [ ] **Step 2: useConversation.ts 消费 queue_update 事件**

在 SSE 事件处理里加：
```typescript
ts.on("queue_update", (entry) => {
  const payload = typeof entry.content === "string" ? safeParse(entry.content) : entry.content;
  if (payload && typeof payload === "object" && "steering" in payload) {
    dispatch({ type: "queue/update", messages: payload.steering });
  }
});
```

注意：`queue_update` 是 AgentSession 事件，不是 conversation ledger 事件。需要确认它是否通过 conversation SSE 传到前端。如果不传，需要后端在 conversation-compose 的 session.subscribe 里转发。

- [ ] **Step 3: useConversation send() 运行中不报错**

send() 的 onError 回调改为：
```typescript
{ onError: (err) => {
    // 409 = busy → 消息已进入 steer 队列（后端已处理），不是错误
    if (err instanceof Error && err.message.includes("409")) return;
    dispatch({ type: "send/error", message: "Send failed — retry" });
  }}
```

- [ ] **Step 4: useConversation 加排队操作方法**

```typescript
const queueEdit = useCallback((index: number, newText: string) => {
  dispatch({ type: "queue/edit", index, text: newText });
}, []);

const queueRemove = useCallback((index: number) => {
  dispatch({ type: "queue/remove", index });
}, []);
```

- [ ] **Step 5: 返回值加 queuedMessages + queueEdit + queueRemove**

- [ ] **Step 6: Commit**

---

## Task 3: 前端 — ConversationCanvas 排队消息区域 + Composer 解禁

**Files:**
- Modify: `apps/web/src/components/ConversationCanvas.tsx`

- [ ] **Step 1: Composer 运行中不禁用**

`disabled={busy}` 改为 `disabled={false}`（或移除 disabled prop）。运行中可以输入。

- [ ] **Step 2: 运行中 placeholder 改为 "Steer the agent..."**

Composer 组件需要接收 busy 状态，动态切换 placeholder。读 Composer 组件确认接口。

- [ ] **Step 3: 排队消息区域**

在 Timeline 和 Composer 之间加排队区域：
```tsx
{state.queuedMessages.length > 0 && (
  <div className="shrink-0 border-t border-[var(--hairline)] bg-[var(--canvas-soft)] px-6 py-3">
    <div className="text-[10px] text-[var(--mute)] uppercase tracking-wide mb-2">
      Queued ({state.queuedMessages.length})
    </div>
    <div className="space-y-2">
      {state.queuedMessages.map((msg, i) => (
        <QueuedMessageBubble
          key={i}
          text={msg}
          onEdit={(newText) => queueEdit(i, newText)}
          onRemove={() => queueRemove(i)}
        />
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 4: QueuedMessageBubble 组件**

内联或单独组件：半透明气泡 + 编辑按钮 + 撤回按钮。编辑用 inline textarea。

- [ ] **Step 5: Commit**

---

## Task 4: 后端 — queue_update 事件转发到 conversation SSE

**Files:**
- Modify: `apps/backend/src/features/conversation/conversation-compose.ts`

- [ ] **Step 1: 确认 queue_update 事件是否已通过 conversation SSE 传到前端**

读 conversation-compose.ts 的 session.subscribe 逻辑——当前只处理 `message_update`/`message`/`todo_update`，不处理 `queue_update`。

如果 queue_update 没转发到 conversation SSE，需要在 session.subscribe 里加：
```typescript
if (event.type === "queue_update") {
  // 通过 conversation SSE 转发
  convPort.appendLedgerEntry({
    conversationId,
    senderMemberId: "__system__",
    kind: "queue_update",  // 或复用现有 kind
    content: { steering: event.steering, followUp: event.followUp },
  });
}
```

但 LedgerKind 可能不支持 "queue_update"。先读 ports.ts 确认 LedgerKind 类型。如果不支持，需要加新 kind 或用其他方式转发（如直接调 SSE subscribers）。

- [ ] **Step 2: Commit**

---

## Task 5: 最终验证

- [ ] **Step 1: typecheck + test + biome**
- [ ] **Step 2: Commit + push**
