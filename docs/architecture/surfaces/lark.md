---
title: 飞书端
description: 飞书入站的鉴权与幂等占位、本地四张表，以及 sse-watcher 的出站过滤链、投递去重与推送游标
tags: [lark, surfaces, backend]
---

# 飞书端

一句话：本页是飞书端的权威描述。飞书端是 lark-bot 进程里的文本桥。入站把飞书群与单聊的消息 POST 给 backend 的 conversation API；出站用 sse-watcher 消费该会话的 conversation SSE，把 assistant 终态行渲染成纯文本发回飞书。sse-watcher 是唯一出站入口，run 的中间态对飞书完全不可见，工具行则按纯文本原样投递。

## 范围

覆盖：入站管线的每一步（鉴权、幂等占位、绑定、路由、POST），本地四张表，出站的过滤链、去重模型、重试与推送游标，内容渲染与截断，surface.control 重绑，进程生命周期与 backend 侧的接线。

不覆盖：backend 侧的触发与执行（见 [飞书消息端到端](../flows/e2e-lark-message.md)）、Web 端（见 [Web 端](./web.md)）、lark-cli 与飞书开放平台的协议细节（本页只讲到进程怎么起）。

## 实现文件

- `apps/lark-bot/src/main.ts` — 起 `lark-cli event consume`、按行解析、watcher 表、重绑、心跳、退出处理
- `apps/lark-bot/src/ingest.ts` — 入站主管线
- `apps/lark-bot/src/bindings-sqlite.ts` — 四张表的读写与 `rebindChatConversation`
- `apps/lark-bot/src/sse-watcher.ts` — 出站主管线
- `apps/lark-bot/src/render.ts` 与 `markdown-normalizer.ts` — 行到文本的渲染、换行与截断
- `apps/lark-bot/src/sender.ts` 与 `send-text-only.ts` — 经 lark-cli 投递
- `apps/lark-bot/src/{bootstrap,args,event-parser,client,safe-agent-id,diagnostics}.ts` — 启动、参数、事件解析、treaty 客户端、id 安全化、心跳
- `apps/lark-bot/src/db/schema.ts` 与 `apps/lark-bot/drizzle/` — 本地 schema 与迁移
- `apps/backend/src/features/agent/{agent-config.ts,agent-lark.ts,http.ts}` — 配置字段与生命周期包装
- `apps/backend/src/features/lark-bot/{registry,profile,setup-manager,provisioner}.ts` — 进程的起停

## 入站

进程用 `spawn("lark-cli", ["--profile", profile, "event", "consume", "im.message.receive_v1", "--as", "bot"])` 起事件消费，profile 默认 `agent:<safeAgentId>`。stdout 按行交给 `parseEvent`，解析失败的行只打日志。每条事件的流水线是 reserve → POST → confirm：

1. **鉴权**（`ingest.ts`）：`sender_type` 存在且不是 `"user"` 直接 skip，防机器人互相触发；再按 `agent.lark.allowedSenders`（open_id 白名单）过滤，白名单为空表示单人自托管，放行所有人。
2. **幂等占位**：`inboundExists` 按 `event_id` 或 `message_id` 命中即 skip，否则 `reserveInbound` 在同一事务里落一行 `status = "processing"`。占位先于 POST，取舍是宁可丢一条入站也不重复触发 run。
3. **绑定解析**：`chat_binding` 缺失时返回 `needCreateConv`；存在时读 `member_binding`，缺失就现写一条 `human:lark:<open_id>`。
4. **建会话**：只有 `needCreateConv` 时调 `POST /api/conversations {agentId}`。之后新会话与老会话都只写本地 `chat_binding` 与 `member_binding`，没有成员相关的 HTTP 调用，后端也没有成员表。
5. **路由**：单聊不传 `senderMemberId` 与 `addressedTo`，由服务端派生成 sender 与 target；群聊传 `senderMemberId`，`addressedTo` 在 `botDisplayName` 存在且 `isBotMentioned` 命中时为 `[selfAgentId]`，否则为 `[]`。缺 `botDisplayName` 时群聊 fail-closed，只能单聊。
6. **POST 消息**：`content` 固定带 `{ text, source: "lark", larkEventId, larkMessageId }`，接口返回 202 与 `{ seq, triggeredRuns }`。
7. **确认**：`confirmInbound` 回填 `conversationId` 与 `ledgerSeq`。POST 之前进程崩掉的话，这条入站不会再被处理。

## 本地四张表

`apps/lark-bot/src/db/schema.ts` 里只有四张表，它们是这个端私有的投递状态，不进后端：

| 表 | 主键 | 用途 |
|---|---|---|
| `chat_binding` | `lark_chat_id` | 飞书 chat → conversationId，带 `pushed_seq` 推送游标 |
| `member_binding` | `(lark_chat_id, lark_open_id)` | 飞书用户 → 本地 memberId 标签，形如 `human:lark:<open_id>` |
| `inbound_message` | `lark_event_id` | 入站幂等，`lark_message_id` 上另有唯一约束 |
| `message_delivery` | `(conversation_id, message_id, lark_chat_id)` | 出站投递意图与最后状态 |

## 出站

每个绑定会话一个 watcher（启动时按 `chat_binding` 全量恢复，新建绑定时补一个）。请求是 `${backendUrl}/api/conversations/:id/events?afterSeq=<pushedSeq>`，游标大于 0 时另带 `Last-Event-ID`。连接失败 5 秒后重试，流正常结束 1 秒后重试。每帧用 `ConversationEvent.parse` 严格校验；SyntaxError 与 ZodError 只打日志并跳过，其它异常重新抛出让连接重连。

`processEntry` 的过滤链顺序固定：

1. `seq <= currentSeq` 的帧直接丢弃，只保证不重复处理。
2. `surface.control` 交给重绑分支处理。
3. 非 `message` 帧、没有 `message` 的帧、`role === "system"`、`role === "user"` 只推进游标。人类自己的话已经在飞书里，不需要回显。`tool` 行不在排除名单里。
4. 查 `message_delivery`，命中且 `isTerminalMessageState(lastState)` 就推进游标跳过。
5. 先 `upsertMessageDelivery` 记投递意图，再渲染发送，最后推进 `pushedSeq`。

canonical 账本只有终态行：`state` 只有 `done` 与 `error` 两种取值，所以飞书没有流式渲染路径，每个 assistant 行只投递一次。

投递用 `lark-cli --profile <p> im +messages-send --chat-id <id> --text <t> --as bot --idempotency-key <conversationId:messageId:seq>`。失败退避重试 3 次（500ms 乘 2 的幂），耗尽后只记日志、不掐断 SSE 流；`main.ts` 把失败转成抛错，用来阻止 `pushedSeq` 前进。

## 内容渲染

`renderRevision` 先取 `text`，没有就拼所有 `type === "text"` 的 block，再没有就返回字面量 `[Unsupported content]`。文本随后过 `normalizeForLarkMarkdown`，做换行与 code fence 收尾；被截断时追加一行 `[消息过长已截断]`。工具行没有专门的呈现形式，它带 `text` 就按原文投递，只有 tool_result 块时落到 `[Unsupported content]`。

## surface.control 重绑

backend 只在「开新对话」时写这个 kind，payload 是 `{ type: "lark.start_new_conversation", oldConversationId, newConversationId, reason, requestedByRunId, idempotencyKey }`，同一 idempotencyKey 重复调用返回既有结果（`apps/backend/src/features/conversation/service.ts`）。HTTP 入口是 `POST /api/conversations/:id/start-new`。

watcher 侧校验 payload 后调 `rebindChatConversation`，成功返回时重置新会话的 `pushedSeq`，关掉旧 watcher、开新 watcher，并发一句「已开启新的对话。」。

## 进程生命周期与 backend 接线

启动顺序在 `bootstrap.ts`：先抢 PID 锁（同 agent 重复启动直接退出），再取 agent 信息（agent 不存在或被归档、`larkEnabled === false` 时优雅退出；backend 不可达则退出码 1，交给 registry 重启），最后打开 SQLite。`main.ts` 读回全部 chat binding 并为每个会话开 watcher。

心跳每 30 秒一次 `postHeartbeat`，内容是 watcher 计数与 `lastError`。`lark-cli` 退出时，码非 0 且信号不是 SIGTERM 就退出码 1（等 registry 重启），SIGTERM 与 SIGINT 会转发信号、清心跳、释放 PID 锁、关 watcher。

backend 侧：`allowed_senders`、`bot_display_name`、`profile_ref` 落在 agent 配置里，create 与 update 走 `withLarkLifecycle`，启用时先 `profileInit` 再 `ensureLarkBot`，归档与硬删时 `stopBot`。dev 环境 registry 用 `bun <lark-bot bin> --agent-id … --backend-url … --state-root …` 起进程，`BACKEND_AUTH_TOKEN` 只走 env 不走 argv；prod 环境 registry 只 resolve 不 spawn，真实状态由外部进程管理器负责。对外的 lark 状态是 `not_configured | configured | running | degraded | error`，由 `agent/http.ts` 的 `deriveLarkStatus` 从配置与 registry 状态合成（配置没开或没有 profile_ref 就是 `not_configured`）。

## 不变量

1. 飞书端不写账本，也不向后端声明任何身份：memberId 是本地标签。
2. 出站只有一个入口 sse-watcher，且只投递账本里的终态行（assistant 与 tool）。
3. 投递意图先落库再发送，发送失败不会在重连后被重发。
4. 每次投递带 lark-cli 的 idempotency key，形如 `<conversationId>:<messageId>:<seq>`。
5. `pushedSeq` 只在投递路径走完之后推进；发送失败会抛错阻止推进。
6. 同一个 agent 同时只有一个 lark-bot 进程（PID 锁）。

## 已知缺口

- `role === "tool"` 的账本行不被过滤，会以原始文本或 `[Unsupported content]` 的形式投递出去。`render.ts` 只认 `text` 与 text block，没有给工具行准备专门的呈现形式。
- `surface.control` 的重绑路径没有生产触发入口：`POST /api/conversations/:id/start-new` 目前只有测试调用，旧的触发工具已不存在。路由与端侧消费都已具备。
- `diagnostics.ts` 里的 `runStreams` 字段是 API 兼容空桩，统计恒为 0，对应的表已经从本地 schema 删除。
- 群聊的 @ 检测依赖 `botDisplayName`，缺了就只有单聊可用。
- 出站没有回执：投递成功与否只体现在 lark-cli 的退出码上。

## 相关页

- [端总览](./overview.md)
- [飞书消息端到端](../flows/e2e-lark-message.md)
- [Conversation History](../conversation/history.md)
- [排障指南](../operations/troubleshooting.md)
