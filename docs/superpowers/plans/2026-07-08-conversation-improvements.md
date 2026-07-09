# Conversation 改进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Spec:** `docs/superpowers/specs/2026-07-08-conversation-improvements.md`

---

## 代码事实

| 事实 | 位置 |
|------|------|
| `subscribeConversation` 100ms 轮询 + push buffer | `service.ts:451-529` |
| `#subscribers` Map + `#notify()` push 机制 | `service.ts:118-133` |
| `GET /api/conversations` 不含 lastActivityAt | `http.ts:10-15` |
| `useRecentConversations` 无 refetchInterval | `apps/web/src/features/conversations/hooks.ts:17-22` |
| `autoTitle` 每次 new AnthropicChatModel | `conversation-compose.ts:70-75` |
| `createModel` 已在 agent-helpers 导出 | `span/agent-helpers.ts:35` |
| `ConversationPort.getLedgerEntries` | `ports.ts:89` |
| 前端 Chat 页面 | `apps/web/src/app/(main)/chat/page.tsx` |
| ConversationCanvas 组件 | `apps/web/src/components/ConversationCanvas.tsx` |

---

## Task 1: P0 -- SSE push-first poll-fallback

**Files:**
- Modify: `apps/backend/src/features/conversation/service.ts`

- [ ] **Step 1: 改 subscribeConversation 为 push-first**

替换 while(true) 循环。核心改动：push buffer 空时，用 `Promise.race([waitForPush, pollTimeout(5s)])` 等待，而非每 100ms 轮询。

实现要点：
- 用一个 `let resolvePush: () => void` 变量
- `onPush` 回调里除了 push 到 buffer，还调 `resolvePush()`（如果有等待者）
- `Promise.race` 唤醒后 drain buffer + 做一次 DB fallback poll
- 心跳改为每 3 次 5s fallback（~15s）发一次
- `pollMs` 参数仍保留（测试用 pollMs=0 one-shot）

- [ ] **Step 2: typecheck + test + commit**

---

## Task 2: P0 -- 会话列表实时更新

**Files:**
- Modify: `apps/backend/src/features/conversation/ports.ts` (加 lastActivityAt)
- Modify: `apps/backend/src/features/conversation/adapter-sqlite.ts` (查 max ts)
- Modify: `apps/backend/src/features/conversation/http.ts` (返回 lastActivityAt)
- Modify: `apps/web/src/features/conversations/hooks.ts` (加 refetchInterval)
- Modify: `apps/web/src/app/(main)/chat/page.tsx` (排序 + 相对时间)

- [ ] **Step 1: 后端 -- ConversationPort 加 lastActivityAt**

`ConversationWithMembers` 接口加 `lastActivityAt: number | null`。adapter-sqlite 的 `listConversations` 查询加 `SELECT MAX(ts) FROM conversation_ledger WHERE conversation_id = ?` 子查询。

- [ ] **Step 2: 前端 -- refetchInterval + 排序**

`useRecentConversations` 加 `refetchInterval: 10_000`。列表按 `lastActivityAt` 降序排序。每项显示相对时间。

- [ ] **Step 3: typecheck + test + commit**

---

## Task 3: P1 -- Auto-title 复用 model

**Files:**
- Modify: `apps/backend/src/features/conversation/conversation-compose.ts`

- [ ] **Step 1: 替换 new AnthropicChatModel 为 createModel**

`autoTitle` 函数里 `new AnthropicChatModel({...})` 替换为 `createModel("claude", config)`。

删除不再需要的 `AnthropicChatModel` import（如果其他地方不用的话）。

- [ ] **Step 2: typecheck + test + commit**

---

## Task 4: P2 -- 消息搜索

**Files:**
- Modify: `apps/backend/src/features/conversation/http.ts` (加 search 端点)
- Modify: `apps/backend/src/features/conversation/ports.ts` (加 searchLedger 方法)
- Modify: `apps/backend/src/features/conversation/adapter-sqlite.ts` (LIKE 查询)
- Modify: `apps/web/src/lib/api.ts` (加 searchConversations)
- Modify: `apps/web/src/app/(main)/chat/page.tsx` (加搜索框 + 结果)

- [ ] **Step 1: 后端 -- search 端点**

`GET /api/conversations/search?q=keyword&limit=20`：
- `ConversationPort.searchLedger(keyword, limit)` -> `Array<{ conversationId, seq, snippet, ts }>`
- SQL: `SELECT conversation_id, seq, substr(content, ...) as snippet, ts FROM conversation_ledger WHERE content LIKE '%keyword%' LIMIT ?`
- http.ts 路由返回 `{ results }`

- [ ] **Step 2: 前端 -- 搜索 UI**

Chat 页面顶部加搜索 Input。输入后调 `searchConversations(q)`。结果列表：每项显示 conversationId + snippet。点击跳转 `/chat/{conversationId}`。

- [ ] **Step 3: typecheck + test + commit**

---

## Task 5: P2 -- 会话导出

**Files:**
- Modify: `apps/backend/src/features/conversation/http.ts` (加 export 端点)
- Modify: `apps/web/src/lib/api.ts` (加 exportConversation)
- Modify: `apps/web/src/components/ConversationCanvas.tsx` (加 Export 按钮)

- [ ] **Step 1: 后端 -- export 端点**

`GET /api/conversations/:id/export` -> `text/markdown`:
- 读 ledger entries，按 seq 排序
- 格式化：`## {ts}\n**{sender}**: {text}\n`
- 返回 `new Response(markdown, { headers: { "content-type": "text/markdown" } })`

- [ ] **Step 2: 前端 -- Export 按钮**

ConversationCanvas 加一个 Export 按钮（下载图标）。点击调 `exportConversation(id)`，blob 下载为 `{conversationId}.md`。

- [ ] **Step 3: typecheck + test + commit**

---

## Task 6: 最终验证

- [ ] typecheck + test + lint
- [ ] commit + push
