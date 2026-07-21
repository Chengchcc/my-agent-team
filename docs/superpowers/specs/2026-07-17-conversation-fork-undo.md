# Spec: Conversation Fork + Undo + Replay

## Problem

用户无法从某条消息重新开始、撤销最近的回复、或回到历史状态重跑。Session Tree 底层已支持 fork/回溯，但没有产品化 -- 没有 API、没有前端 UI、用户触达不到。

llm-space 的 Thread 是可编辑快照，用户可随时编辑/删除消息然后重跑。我们的 conversation ledger 是 append-only，不能编辑/删除中间消息。

## Goal

在现有 conversation ledger + Session Tree 基础上，实现三个产品功能：

1. **Fork from message** -- 从任意消息分叉新对话，保留之前的历史
2. **Undo** -- 撤销最近的 agent 回复（+ 可选的用户消息），回到之前状态
3. **Replay** -- 编辑某条 user message 后从那里重跑

## Design

### API

```
POST /api/conversations/:id/fork
  body: { fromSeq: number, title?: string }
  返回: { newConversationId: string }
  -- 从 fromSeq 对应的消息分叉新对话，复制 1..fromSeq 的消息

POST /api/conversations/:id/undo
  body: { count?: number }  // 默认 1，撤销最近 N 条消息
  返回: { undoneSeqs: number[] }
  -- 标记最近 N 条消息为 "undone"（软删除，ledger 保持 append-only）

POST /api/conversations/:id/replay
  body: { fromSeq: number, editedContent: string }
  返回: { newConversationId: string }
  -- fork + 编辑 fromSeq 的消息内容 + 触发 agent run
```

### Fork 实现

Fork 不修改原对话。创建新 conversation，复制原对话 seq 1..fromSeq 的 ledger entries：

```typescript
async forkConversation(input: {
  conversationId: string;
  fromSeq: number;
  title?: string;
}): Promise<{ newConversationId: string }> {
  // 1. 创建新 conversation
  const newId = this.#idGen();
  this.port.createConversation({
    conversationId: newId,
    triggerMode: "mention",
    title: input.title ?? `Fork of ${input.conversationId.slice(0, 8)}`,
    createdAt: Date.now(),
    origin: "fork",
  });

  // 2. 复制成员
  const members = this.port.getMembers(input.conversationId);
  for (const m of members) {
    this.port.addMember({
      conversationId: newId,
      memberId: m.memberId,
      kind: m.kind,
      agentId: m.agentId,
      displayName: m.displayName,
      joinedAt: Date.now(),
    });
  }

  // 3. 复制 ledger entries (seq 1..fromSeq)
  const entries = this.port.getLedgerEntries(input.conversationId)
    .filter(e => e.seq <= input.fromSeq && !e.undone);
  for (const entry of entries) {
    this.port.appendLedgerEntry({
      conversationId: newId,
      senderMemberId: entry.senderMemberId,
      addressedTo: entry.addressedTo,
      kind: entry.kind,
      content: entry.content,
      ts: entry.ts,
    });
  }

  // 4. 记录 fork 关系（新 DB 列或 settings KV）
  // ponytail: 用 settings KV 存 fork 元数据
  // key: `fork.${newId}` -> { source: conversationId, fromSeq }

  // 5. 返回新对话 ID
  return { newConversationId: newId };
}
```

### Undo 实现

Undo 是软删除 -- ledger 保持 append-only，但标记消息为 undone：

```typescript
async undoMessages(input: {
  conversationId: string;
  count: number; // 默认 1
}): Promise<{ undoneSeqs: number[] }> {
  const entries = this.port.getLedgerEntries(input.conversationId)
    .filter(e => e.kind === "message" && !e.undone);

  const toUndo = entries.slice(-input.count);
  const undoneSeqs: number[] = [];

  for (const entry of toUndo) {
    this.port.markLedgerEntryUndone(input.conversationId, entry.seq);
    undoneSeqs.push(entry.seq);
  }

  // 广播 undo 事件
  await this.#appendAndBroadcast({
    conversationId: input.conversationId,
    senderMemberId: "__system__",
    addressedTo: [],
    kind: "undo",
    content: { undoneSeqs },
  });

  return { undoneSeqs };
}
```

DB 改动：`conversation_ledger` 表加 `undone INTEGER DEFAULT 0` 列。

### Replay 实现

Replay = fork + 编辑 + 触发：

```typescript
async replayFromMessage(input: {
  conversationId: string;
  fromSeq: number;
  editedContent: string;
}): Promise<{ newConversationId: string }> {
  // 1. Fork
  const { newConversationId } = await this.forkConversation({
    conversationId: input.conversationId,
    fromSeq: input.fromSeq - 1, // 不包含被编辑的消息
  });

  // 2. 追加编辑后的消息
  await this.#appendAndBroadcast({
    conversationId: newConversationId,
    senderMemberId: "human-user", // 从原消息获取
    addressedTo: ["default"], // 从原消息获取
    kind: "message",
    content: input.editedContent,
  });

  // 3. 触发 agent run
  // 复用 postMessage 的 trigger 逻辑

  return { newConversationId };
}
```

### 前端 UI

**Conversation 页面（消息列表）：**

每条消息 hover 时显示操作按钮：
- user message: `[Edit & Replay]` `[Fork from here]`
- assistant message: `[Undo]` `[Fork from here]`

**Edit & Replay flow：**
1. 点击 Edit & Replay
2. 消息变为可编辑 textarea
3. 用户修改后点确认
4. 调 `POST /api/conversations/:id/replay`
5. 跳转到新 fork 对话

**Undo flow：**
1. 点击 Undo
2. 确认对话框
3. 调 `POST /api/conversations/:id/undo`
4. 消息变灰显示 "undone"
5. 不跳转，留在当前对话

**Fork flow：**
1. 点击 Fork from here
2. 调 `POST /api/conversations/:id/fork`
3. 跳转到新 fork 对话

**Conversation list 页面：**

每个 conversation card 显示 fork 来源标记：
```
[标题]
forked from [原对话名] · 2h ago
```

### Session Tree 集成（不做）

Conversation fork 和 session tree fork 是两层不同的 fork，不耦合：

- Conversation fork（本 spec）：用户级别的对话分叉，复制 conversation ledger entries 到新对话。新对话的 agent 从 ledger 重建上下文，session tree 从空开始 -- 这是正确行为，新对话是一条新的对话线，不需要继承原对话的 checkpointer/session 状态。
- Session tree fork（sessionRepo.fork / session.moveTo）：agent session 内部的分支/回溯，用于同一个对话内 agent 中途 fork 思考分支或回溯到某节点重跑。这是 checkpointer 层的能力，和 conversation ledger 是两套独立数据。

两层 fork 各自独立工作，不需要打通。未来如果需要在 fork 出的新对话里保留原对话的 agent 记忆线（而非从 ledger 重建），再考虑集成。

### DB 改动

```sql
-- migration 0011
ALTER TABLE conversation_ledger ADD COLUMN undone INTEGER DEFAULT 0;
ALTER TABLE conversation ADD COLUMN fork_source TEXT;
ALTER TABLE conversation ADD COLUMN fork_from_seq INTEGER;
```

## 不做

- 不做消息内联编辑（只做 fork+edit+replay，不在原对话上改消息）
- 不做 run snapshot（Session Tree 的 CompactionEntry 已提供可逆压缩）
- 不做 A/B 评估（llm-space 独有，我们不需要）
- 不做消息删除（undo 是软删除，不物理删）

## Files Touched

### 新增
- `apps/backend/src/features/conversation/fork-service.ts` -- fork/undo/replay 逻辑
- `apps/backend/drizzle/backend/0011_conversation_fork.sql` -- migration

### 修改
- `apps/backend/src/features/conversation/ports.ts` -- markLedgerEntryUndone
- `apps/backend/src/features/conversation/adapter-sqlite.ts` -- undone 列读写
- `apps/backend/src/features/conversation/service.ts` -- fork/undo/replay 方法
- `apps/backend/src/features/conversation/http.ts` -- 3 个新路由
- `apps/web/src/lib/api.ts` -- fork/undo/replay API
- `apps/web/src/components/ConversationCanvas.tsx` -- 消息 hover 按钮
- `apps/web/src/app/(main)/chat/page.tsx` -- fork 来源标记
