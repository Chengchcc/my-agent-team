# Spec: Conversation 改进 -- SSE 优化 + 列表实时 + 复用 model + 消息搜索 + 导出

> 状态：待评审
> 关联：ADR 0011（Web IA Work/Chat/Team）

## 1. 目标

优化 conversation 实时性、列表可见性、模型复用、搜索能力和导出能力。

## 2. P0: SSE 轮询优化

### 2.1 问题

`subscribeConversation` 同时有 push buffer（`#subscribers` + `notify()`）和 100ms DB 轮询。push buffer 已覆盖实时性，轮询是冗余的，产生持续 DB 压力。

### 2.2 修复

改为 **push-first, poll-fallback** 模式：

1. push buffer 有数据时：drain buffer，跳过轮询
2. push buffer 空时：`await Promise.race([waitForPush, pollTimer])` -- push 到来时立即唤醒，否则 5s 后 fallback 轮询一次（兜底 push 丢失）
3. 心跳保留（每 ~15s 一次 sentinel）

```typescript
// 替换当前 while(true) 循环
while (true) {
  if (opts?.signal?.aborted) break;

  // 1. Drain push buffer first
  while (pushBuffer.length > 0) {
    const entry = pushBuffer.shift()!;
    yield entry;
    if (entry.seq > lastSeq) lastSeq = entry.seq;
    silentPolls = 0;
  }

  // 2. If buffer empty, wait for push OR poll timeout (5s fallback)
  if (pushBuffer.length === 0) {
    let resolveWait!: () => void;
    const pushPromise = new Promise<void>((r) => {
      resolveWait = r;
      // Temporarily wrap onPush to also resolve the wait
      const origOnPush = onPush;
      // ... actually simpler: just use the existing onPush + a race
    });

    const pollTimeout = new Promise<void>((r) => setTimeout(r, 5000));

    // Re-register onPush to also resolve pushPromise
    const wrappedPush = (entry: LedgerEntry) => {
      onPush(entry);
      resolveWait();
    };
    subs.delete(onPush);
    subs.add(wrappedPush);

    await Promise.race([pushPromise, pollTimeout]);

    // Restore original onPush
    subs.delete(wrappedPush);
    subs.add(onPush);

    // After waking up, drain buffer + do one DB poll as fallback
    while (pushBuffer.length > 0) {
      const entry = pushBuffer.shift()!;
      yield entry;
      if (entry.seq > lastSeq) lastSeq = entry.seq;
      silentPolls = 0;
    }
    const entries = this.port.getLedgerEntries(conversationId, { sinceSeq: lastSeq });
    for (const entry of entries) {
      yield entry;
      lastSeq = entry.seq;
      silentPolls = 0;
    }
    if (entries.length === 0) {
      silentPolls++;
      if (silentPolls % 3 === 0) { // ~15s at 5s fallback
        yield heartbeat sentinel;
      }
    }
  }
}
```

简化实现：用一个 `EventEmitter` 或回调 resolve 模式。关键是 push 到来时立即唤醒，不空转。

### 2.3 验收

- SSE 有新消息时 < 50ms 推送（push path）
- 无消息时每 5s 才查一次 DB（非 100ms）
- 心跳保留
- 现有 conversation test 通过

## 3. P0: 会话列表实时更新

### 3.1 问题

`useRecentConversations` 是一次性 fetch，新消息到达时列表不更新。

### 3.2 修复

**后端**：`GET /api/conversations` 每个 conversation 加 `lastActivityAt` 字段（最后一条 ledger entry 的时间戳）。

**前端**：
- `useRecentConversations` 加 `refetchInterval: 10_000`（10s 轮询刷新列表）
- 列表项按 `lastActivityAt` 排序（最新在前）
- 可选：列表项显示相对时间（"3 分钟前"）

### 3.3 验收

- `GET /api/conversations` 返回 `lastActivityAt`
- 列表每 10s 自动刷新
- 新消息的会话排到最前

## 4. P1: Auto-title 复用 model

### 4.1 问题

`autoTitle` 每次 `new AnthropicChatModel()`，创建新 SDK 客户端。

### 4.2 修复

复用 `createModel("claude", config)`（已在 agent-helpers.ts 导出）。

### 4.3 验收

- `autoTitle` 不再 `new AnthropicChatModel`
- typecheck 通过

## 5. P2: 消息搜索

### 5.1 问题

无法搜索会话内容。

### 5.2 修复

**后端**：`GET /api/conversations/search?q=keyword&limit=20` -> 全文搜索 ledger entry 的 content 字段（LIKE '%keyword%'），返回 `{ conversationId, seq, snippet, ts }[]`。

**前端**：Chat 页面加搜索框，结果列表点击跳转到对应会话。

### 5.3 验收

- `GET /api/conversations/search?q=hello` 返回包含 "hello" 的消息
- 前端有搜索入口

## 6. P2: 会话导出

### 6.1 问题

无法导出对话记录。

### 6.2 修复

**后端**：`GET /api/conversations/:id/export` -> 返回 `text/markdown` 格式的对话记录。

格式：
```markdown
# {conversation title or id}

## {timestamp}
**{sender display name}**: {message text}

## {timestamp}
**{sender display name}**: {message text}
...
```

**前端**：ConversationCanvas 加"Export"按钮，点击下载 markdown 文件。

### 6.3 验收

- `GET /api/conversations/:id/export` 返回 markdown
- 前端有导出按钮

## 7. 不做的事

- 不做 SSE 架构重写（只优化 polling 策略）
- 不做消息编辑/删除
- 不做 @mention UI 高亮
- 不做会话置顶/归档

## 8. 验收标准

1. SSE push 到来时 < 50ms 推送，无消息时 5s 才查 DB
2. `GET /api/conversations` 返回 `lastActivityAt`
3. 列表每 10s 自动刷新，新消息会话排前
4. `autoTitle` 复用 model
5. `GET /api/conversations/search?q=keyword` 返回匹配消息
6. `GET /api/conversations/:id/export` 返回 markdown
7. 前端有搜索入口 + 导出按钮
8. typecheck + test + lint 全绿
