---
title: 端总览
description: 端拥有什么（采集、渲染、本地身份映射与去重）与不拥有什么，Web、飞书、终端三种端的差别
tags: [surfaces, web, lark, terminal]
---

# 端总览

一句话：本页是「端」的权威描述。端是把外部入口接上产品核心的适配器，现在有三个：浏览器对话页 `/chat/[id]`、飞书群与单聊、worktree 终端页 `/coding`。端负责输入采集、渲染、端本地的身份映射与 UX 级去重、重试展示，不拥有任何持久事实。

## 范围

覆盖：端拥有什么与不拥有什么，Web 与飞书在身份、实时产出、消耗的流、主要风险上的差别，终端端与两个对话端的结构差别。

不覆盖：单端内部实现（见 [Web 端](./web.md)、[飞书](./lark.md)）、账本与 Context 的定义（见 [Conversation History](../conversation/history.md)）、Run 生命周期与事件目录（见 [Run 输出与实时更新](../runs/output-and-live-updates.md)）。

## 实现文件

- `apps/web/src/hooks/useConversation.ts` — Web 对话页的两条 SSE 与 busy 推导
- `apps/web/src/lib/conversation-reducer.ts` — Web 渲染状态机
- `apps/web/src/features/coding/components/coding-page.tsx` — 终端页
- `apps/lark-bot/src/ingest.ts` — 飞书入站
- `apps/lark-bot/src/sse-watcher.ts` — 飞书唯一出站入口
- `apps/backend/src/features/conversation/http.ts` — 两个对话端共用的线路
- `apps/backend/src/features/coding/http.ts` — 终端端的 REST 与 WS

## 端拥有什么

输入采集。Web 发送走 `usePostConversationMessage` → `api.postConversationMessage` → `POST /api/conversations/:id/messages`。飞书走 `spawn("lark-cli", … "event", "consume", …)` 的 stdout 行循环。

渲染。Web 是 `conversation-reducer.ts` 加 `components/Timeline.tsx`。飞书是 `apps/lark-bot/src/render.ts`，只出纯文本。

端本地的身份映射，只有飞书有。飞书 open_id 在本地 SQLite 里映射成 `human:lark:<open_id>` 标签（`apps/lark-bot/src/bindings-sqlite.ts`）。Web 对话没有身份翻译层，viewer 恒为常量 `"user"`，agent 侧 sender 由 `ConversationSnapshot.agentId` 决定。

UX 级去重。Web 用乐观消息替换最近一条 `opt-` 前缀消息（`apps/web/src/lib/conversation-reducer.ts` 的 `upsertAuthoritative`）。飞书用 `message_delivery` 表判终态（`apps/lark-bot/src/sse-watcher.ts`）。

重试与错误展示。Web 是错误条加 Retry 按钮（`apps/web/src/components/ConversationCanvas.tsx`）。飞书发送失败退避 3 次。

## 端不拥有什么

账本真相。`conversation_ledger` 只有三个写入方：Conversation 服务的 `#appendAndBroadcast` 写人类消息、`undo` 与 `surface.control`，Agent Run 的 `commitCompletedRun` 写 assistant 与 tool 消息，`bootstrap/features.ts` 的 `onRunFailed` 写失败气泡。

执行事实流真相在 `apps/backend/src/features/agent-run/execution-live.ts`：per-run 事件只广播给当前进程的订阅者，不落库，重连之后不保证重现。

触发语义。`postMessage` 里 `trigger = (addressedTo ?? [agentId]).includes(agentId)`，mode 的三态推断也在同一处，端只能提诉求，不能决定。

## Web 与飞书的差异

| 维度 | Web | 飞书 |
|---|---|---|
| 身份 | 无映射，viewer 恒为 `"user"` | open_id → 本地 memberId 标签 |
| 实时产出 | 订阅 per-run SSE，渲染成临时气泡 | 没有实时产出，只渲染终态行 |
| 消耗的流 | conversation SSE 加每个 run 一条 run SSE | 每个绑定会话一条 conversation SSE |
| 最终产出 | 账本的 canonical 消息 | 账本终态行渲染成纯文本 |
| 主要风险 | 乐观消息残留、临时气泡不替换 | 重连重放导致重复投递 |

两端消费同一条线路：`GET /api/conversations/:id/events`。线路上只有三个事件名：`message`、`undo`、`surface.control`（`packages/api-contract/src/sse.ts`）。

## 终端端

`/coding` 与对话端没有共享状态。对话页走 Agent Run（adapter spawn 的 oma 子进程，产物进账本），终端页走 backend 进程持有的裸 PTY，产物不进账本，也不需要 Run Token。终端页有自己的鉴权通道（一次性 ticket 加直连 WebSocket），细节见 [Web 端](./web.md) 的 Coding 小节。

## 不变量

1. 端不写账本，账本写入只发生在后端上述三处。
2. 端看到的中间态都不是事实：run 事件流是 transient projection。
3. 飞书本地的四张绑定表只影响这个端怎么送达，不影响后端状态。
4. 端之间的输入不共享：同一会话的两个端各自采集、各自渲染。

## 已知缺口

- Web 的 notice 通道没有输入：只有 `role: "system"` 的账本消息会渲染成 notice，而后端只写 `role: "user"` 与 `role: "assistant"` 两种。
- 存储层 kind 枚举里仍留着 `member.joined`、`member.left`、`todo`（`apps/backend/src/features/conversation/ledger-codec.ts`），但没有任何写入方，线上事件枚举已经把它们剔除。

## 相关页

- [Web 端](./web.md)
- [飞书](./lark.md)
- [Conversation History](../conversation/history.md)
- [Run 输出与实时更新](../runs/output-and-live-updates.md)
