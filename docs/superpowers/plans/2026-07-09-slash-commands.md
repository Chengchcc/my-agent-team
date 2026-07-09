# Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Spec:** `docs/superpowers/specs/2026-07-09-slash-commands.md`

---

## 代码事实

| 事实 | 位置 |
|------|------|
| Composer 输入检测 + @mention popover | `apps/web/src/components/Composer.tsx:104-123` |
| Composer handleSend | `Composer.tsx:125-140` |
| ConversationCanvas 传 send 给 Composer | `ConversationCanvas.tsx:357-363` |
| useConversation send 方法 | `hooks/useConversation.ts:210-239` |
| conversation-reducer toggleTriggerMode action | `conversation-reducer.ts:54` |
| POST /api/ops/runs/:id/cancel 已有 | `runtime-ops/http.ts:18` |
| GET /api/conversations/:id/export 已有 | `conversation/http.ts` |
| GET /api/conversations/search 已有 | `conversation/http.ts` |
| POST /api/conversations/:id/members 已有 | `conversation/http.ts` |
| ConversationPort.setConversationTitle | `conversation/ports.ts:75` |
| AgentSession.compact() | `harness/src/agent-session.ts:229` |
| AgentSession.dispose() | `harness/src/agent-session.ts:197` |
| sessionManager.get/dispose | `span/session-manager.ts:74-85` |
| convPort.updateMemberSessionId | `conversation/ports.ts:86` |

---

## Task 1: 后端 -- clear + compact 端点

**Files:**
- Modify: `apps/backend/src/features/conversation/http.ts`
- Modify: `apps/backend/src/features/conversation/service.ts` (加 clear/compact 方法)

- [ ] **Step 1: service.ts -- 加 clearConversation 方法**

```typescript
async clearConversation(conversationId: string): Promise<void> {
  // Dispose all active agent sessions for this conversation
  const convSessions = this.#activeSessions.get(conversationId);
  if (convSessions) {
    for (const [_memberId, session] of convSessions) {
      // session 对象有 steer/followUp，但没有 dispose
      // 需要通过 sessionManager 或回调来 dispose
    }
    this.#activeSessions.delete(conversationId);
  }
  // Clear session bindings so next prompt creates fresh session
  const members = this.port.getMembers(conversationId);
  for (const m of members) {
    if (m.kind === "agent" && m.sessionId) {
      this.port.updateMemberSessionId(conversationId, m.memberId, "");
    }
  }
  // Release lock if held
  this.#lock.releaseAll?.(conversationId);
}
```

注意：service 层没有 sessionManager 引用。需要在 ConversationServiceDeps 加 `disposeSession?: (sessionId: string) => void` 可选回调。

- [ ] **Step 2: service.ts -- 加 compactConversation 方法**

```typescript
async compactConversation(conversationId: string): Promise<void> {
  // 需要通过回调访问 AgentSession.compact()
  // service 层不持有 AgentSession，需要 deps 注入
}
```

同样需要 deps 加 `compactSession?: (sessionId: string) => Promise<void>` 回调。

**更简单的方案**：不在 service 层实现，直接在 http.ts 里用注入的回调。或者：给 ConversationServiceDeps 加 `onClear?: (conversationId: string) => void` 和 `onCompact?: (conversationId: string) => Promise<void>` 回调，由 conversation-compose 注入。

- [ ] **Step 3: http.ts -- 加两个 POST 路由**

```typescript
.post("/api/conversations/:id/clear", async ({ params: { id }, set }) => {
  await svc.clearConversation(id);
  return { ok: true };
})
.post("/api/conversations/:id/compact", async ({ params: { id }, set }) => {
  await svc.compactConversation(id);
  return { ok: true };
})
```

- [ ] **Step 4: conversation-compose.ts -- 注入 clear/compact 回调**

```typescript
const convSvc = createConversationService({
  ...
  onClear: (conversationId: string) => {
    // Dispose active sessions + clear member session bindings
    const convSessions = activeSessions.get(conversationId);
    if (convSessions) {
      for (const [_memberId, _handlers] of convSessions) {
        // Need to get AgentSession and dispose it
        // 但 activeSessions 存的是 { steer, followUp } 不是 AgentSession
      }
      activeSessions.delete(conversationId);
    }
    const members = convPort.getMembers(conversationId);
    for (const m of members) {
      if (m.kind === "agent" && m.sessionId) {
        sessionManager.dispose(m.sessionId);
        convPort.updateMemberSessionId(conversationId, m.memberId, "");
      }
    }
  },
  onCompact: async (conversationId: string) => {
    const members = convPort.getMembers(conversationId);
    for (const m of members) {
      if (m.kind === "agent" && m.sessionId) {
        const session = sessionManager.get(m.sessionId);
        if (session) {
          await session.compact();
        }
      }
    }
  },
});
```

- [ ] **Step 5: typecheck + test + commit**

---

## Task 2: 前端 -- 命令注册表 + Composer 集成

**Files:**
- Create: `apps/web/src/lib/slash-commands.ts`
- Modify: `apps/web/src/components/Composer.tsx`
- Modify: `apps/web/src/components/ConversationCanvas.tsx`
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: api.ts -- 加 clearConversation + compactConversation + updateConversationTitle**

```typescript
clearConversation: (id: string) =>
  unwrap(client.api.conversations({ id }).clear.post({})),
compactConversation: (id: string) =>
  unwrap(client.api.conversations({ id }).compact.post({})),
```

`updateConversationTitle` 需要检查是否已有 PATCH 端点。如果没有，加一个 `PATCH /api/conversations/:id` 接受 `{ title?: string }`。

- [ ] **Step 2: slash-commands.ts -- 注册表**

定义 `SlashCommand` 接口 + `slashCommands` 数组 + `CommandContext` 类型。

- [ ] **Step 3: Composer.tsx -- 检测 / 开头 + 命令提示 popover**

在 `handleInput` 里加 `/` 检测。在 `handleSend` 里加命令匹配。

- [ ] **Step 4: ConversationCanvas.tsx -- 传 CommandContext**

Canvas 从 useConversation 拿 dispatch、从 api 拿调用能力，组装成 CommandContext 传给 Composer。

- [ ] **Step 5: typecheck + commit**

---

## Task 3: 最终验证

- [ ] typecheck + test + lint
- [ ] commit + push
