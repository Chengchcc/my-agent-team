---
title: 飞书端
description: 飞书入站的鉴权与幂等占位、本地五张表，Run 流式卡片（ADR 0031），以及 sse-watcher 的出站过滤链、卡片去重缝、投递去重与推送游标
tags: [lark, surfaces, backend]
---

# 飞书端

一句话：本页是飞书端的权威描述。飞书端是 lark-bot 进程。入站把飞书群与单聊的消息 POST 给 backend 的 conversation API（`/stop` 控制命令除外，它直接调 Run 取消接口）。出站有两条：Run 流式卡片（ADR 0031，消费 Run SSE 的 transient 投影，终态以 canonical 文本封版）与 sse-watcher 的会话终态文本（卡片不拥有投递时的兜底通道）。工具行不投递，卡片上只显示工具摘要。

## 范围

覆盖：入站管线的每一步（鉴权、幂等占位、绑定、路由、POST、/stop），本地五张表，Run 卡片生命周期，出站的过滤链、卡片去重缝、去重模型、重试与推送游标，内容渲染与截断，surface.control 重绑，进程生命周期与 backend 侧的接线。

不覆盖：backend 侧的触发与执行（见 [飞书消息端到端](../flows/e2e-lark-message.md)）、Web 端（见 [Web 端](./web.md)）、lark-cli 与飞书开放平台的协议细节（本页只讲到进程怎么起）。

## 实现文件

- `apps/lark-bot/src/main.ts` — 起 `lark-cli event consume`、按行解析、watcher 表、重绑、心跳、退出处理
- `apps/lark-bot/src/ingest.ts` — 入站主管线与 `/stop` 控制命令
- `apps/lark-bot/src/bindings-sqlite.ts` — 五张表的读写与 `rebindChatConversation`
- `apps/lark-bot/src/run-card/` — Run 卡片：`card-sender.ts`（lark-cli 发卡与 PATCH）、`card-state.ts`（事件→状态的纯 reducer）、`card-renderer.ts`（Card JSON 2.0 + streaming_mode）、`card-flush.ts`（单飞 flush 控制器）、`run-card-watcher.ts`（生命周期与终态封版）
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

## 本地五张表

`apps/lark-bot/src/db/schema.ts` 里的表都是这个端私有的投递状态，不进后端：

| 表 | 主键 | 用途 |
|---|---|---|
| `chat_binding` | `lark_chat_id` | 飞书 chat → conversationId，带 `pushed_seq` 推送游标 |
| `member_binding` | `(lark_chat_id, lark_open_id)` | 飞书用户 → 本地 memberId 标签，形如 `human:lark:<open_id>` |
| `inbound_message` | `lark_event_id` | 入站幂等，`lark_message_id` 上另有唯一约束 |
| `message_delivery` | `(conversation_id, message_id, lark_chat_id)` | 文本桥出站投递意图与最后状态 |
| `run_card` | `run_id` | Run 卡片投递状态：lark 消息 id、状态机、累计输出、失败计数（ADR 0031） |

## 出站

每个绑定会话一个 watcher（启动时按 `chat_binding` 全量恢复，新建绑定时补一个）。请求是 `${backendUrl}/api/conversations/:id/events?afterSeq=<pushedSeq>`，游标大于 0 时另带 `Last-Event-ID`。连接失败 5 秒后重试，流正常结束 1 秒后重试。每帧用 `ConversationEvent.parse` 严格校验；SyntaxError 与 ZodError 只打日志并跳过，其它异常重新抛出让连接重连。

`processEntry` 的过滤链顺序固定：

1. `seq <= currentSeq` 的帧直接丢弃，只保证不重复处理。
2. `surface.control` 交给重绑分支处理。
3. 非 `message` 帧、没有 `message` 的帧、`role === "system"`、`role === "user"`、`role === "tool"` 的行只推进游标。人类自己的话已经在飞书里，不需要回显；工具行的原始输出不进群聊（摘要属于 Run 卡片，见 ADR 0031）。
4. 查 `message_delivery`，命中且 `isTerminalMessageState(lastState)` 就推进游标跳过。
5. 先以非终态标记（`streaming`）写投递意图，再渲染发送；发送成功后才写终态确认并推进 `pushedSeq`。

canonical 账本只有终态行：`state` 只有 `done` 与 `error` 两种取值，所以飞书没有流式渲染路径，每个 assistant 行只投递一次。

投递用 `lark-cli --profile <p> im +messages-send --chat-id <id> --text <t> --as bot --idempotency-key <conversationId:messageId:seq>`。失败退避重试 3 次（500ms 乘 2 的幂），耗尽后抛错断开本连接，重连后从游标重放该条并以同一幂等键重发（Lark 侧去重）；语义是 at-least-once（ADR 0032）。

## Run 卡片（ADR 0031 第一期）

ingest 拿到 `triggeredRuns` 后立刻为每个 run 建 CardKit 卡片实体并发送引用消息，状态机 `creating → streaming → waiting → completed | failed | cancelled | fallback_text`。**热路径直连 CardKit OpenAPI**（`run-card/card-kit.ts`，纯 fetch）；tenant token 由 `lark-api.ts` 从 lark-cli 本地密钥库解出 secret 自行铸造并缓存——lark-cli 只保留 profile 管理、入站事件与普通文本发送。事件消费 `/api/agent-runs/:runId/events`：text_delta 追加正文、tool 事件进状态行摘要、approval/ask 切「等待」帧、终态触发封版。

- **传输分层（决策 9）**：逐字流式 = `PUT /cards/:id/elements/:element_id/content`（累计全文 + 严格递增 `card_seq`，客户端对前缀扩展做打字机动画）；header 变化与终态 = 全卡替换 `PUT /cards/:id`（流式元素改不了 header，这是唯一途径）；终态替换后必须 `PATCH /cards/:id/settings` 关闭 streaming_mode，客户端才离开流式视图。
- **节流与节拍**：150ms/120 字符合并、单飞 flush（互斥 + 补刷 + 只推变化元素）；另有一个 1 秒状态节拍器，保证「耗时 N 秒」在模型思考/工具运行期间也每秒跳动（内容没变就不发请求）。
- **终态封版**：`GET /api/agent-runs/:runId` 的 `terminalResult.messages` 取最后一条带文本的 assistant 消息（与账本提交同源），重试 3 次等落库；封版替换失败降级为发送最终纯文本（`larkIdempotencyKey` 哈希键）并把卡标 `fallback_text`。
- **与文本桥的去重缝（决策 8）**：assistant 行的 messageId 形如 `run:<runId>:assistant:<n>`，sse-watcher 投递前解析它——该 (runId, chat) 的卡片存在且不是 `fallback_text` 就跳过文本发送；卡片从创建起拥有投递权，失败即 `fallback_text` 交还文本桥。
- **控制（决策 6，已实现）**：活卡带红色「停止」按钮（`behaviors:[{type:"callback",value:{runId,action:"stop"}}]`）；点击经 lark-cli ≥1.0.9x 的 `card.action.trigger` 长连接回调 → `run-card/card-actions.ts` 校验（event_id 去重、message↔run_card 映射、chat/run 匹配，action_value 永不单独被信任）→ `POST /api/agent-runs/:runId/cancel` → cancelled 终态封灰。`/stop` 入站命令为等价通道，成功即沉默（卡片即反馈）。
- **正文窗口**：最近约 10k 字符，头部折叠提示去 Web（`--web-url`/`LARK_WEB_URL`，Markdown 链接形态）。
- **幂等键**：飞书 `--idempotency-key` 有 **50 字符上限**（99992402），自然键天然超限，统一 `larkIdempotencyKey()` 哈希成 40 位十六进制。
- **重启恢复**：启动读回非终态 `run_card` 行（含 `card_kit_id` 与 `card_seq`）继续驱动；Run SSE 晚订阅语义保证已结算 run 立即给终态。
- **配额警示**：每应用**卡片实体绑定数有配额**（错误 200780，实测约 18 张触发）；高频部署需关注，或为超配额场景保留 IM-patch 降级路径。

## 内容渲染

`renderRevision` 先取 `text`，没有就拼所有 `type === "text"` 的 block，再没有就返回字面量 `[Unsupported content]`。文本随后过 `normalizeForLarkMarkdown`，做换行与 code fence 收尾；被截断时追加一行 `[消息过长已截断]`。工具行到不了渲染：它们在过滤链第 3 步就被跳过。

## surface.control 重绑

backend 只在「开新对话」时写这个 kind，payload 是 `{ type: "lark.start_new_conversation", oldConversationId, newConversationId, reason, requestedByRunId, idempotencyKey }`，同一 idempotencyKey 重复调用返回既有结果（`apps/backend/src/features/conversation/service.ts`）。HTTP 入口是 `POST /api/conversations/:id/start-new`。

watcher 侧校验 payload 后调 `rebindChatConversation`，成功返回时重置新会话的 `pushedSeq`，关掉旧 watcher、开新 watcher，并发一句「已开启新的对话。」。

## 进程生命周期与 backend 接线

启动顺序在 `bootstrap.ts`：先抢 PID 锁（同 agent 重复启动直接退出），再取 agent 信息（agent 不存在或被归档、`larkEnabled === false` 时优雅退出；backend 不可达则退出码 1，交给 registry 重启），最后打开 SQLite。`main.ts` 读回全部 chat binding 并为每个会话开 watcher。

心跳每 30 秒一次 `postHeartbeat`，内容是 watcher 计数与 `lastError`。`lark-cli` 退出时，码非 0 且信号不是 SIGTERM 就退出码 1（等 registry 重启），SIGTERM 与 SIGINT 会转发信号、清心跳、释放 PID 锁、关 watcher。

backend 侧：`allowed_senders`、`bot_display_name`、`profile_ref` 落在 agent 配置里，create 与 update 走 `withLarkLifecycle`，启用时先 `profileInit` 再 `ensureLarkBot`，归档与硬删时 `stopBot`。dev 环境 registry 用 `bun <lark-bot bin> --agent-id … --backend-url … --state-root …` 起进程，`BACKEND_AUTH_TOKEN` 只走 env 不走 argv；prod 环境 registry 只 resolve 不 spawn，真实状态由外部进程管理器负责。对外的 lark 状态是 `not_configured | configured | running | degraded | error`，由 `agent/http.ts` 的 `deriveLarkStatus` 从配置与 registry 状态合成（配置没开或没有 profile_ref 就是 `not_configured`）。

## 不变量

1. 飞书端不写账本，也不向后端声明任何身份：memberId 是本地标签。
2. 出站有两个入口：Run 卡片（Run 的 UX 生命周期，含终态）与 sse-watcher（终态 assistant 文本兜底）；对同一条 assistant 行，只有 `fallback_text` 的卡片会让位给文本桥。
3. 卡片是 Run 的 transient 投影：token delta 不持久化到后端，PATCH 失败不影响 Run，终态必须以 canonical 文本封版或降级纯文本送达（ADR 0031/0032）。
4. 文本桥投递意图以非终态标记先落库，发送成功才确认终态；发送失败经重连重放，靠幂等键去重（at-least-once）。
5. 每次文本投递带 lark-cli 的 idempotency key，形如 `<conversationId>:<messageId>:<seq>`；卡片幂等键是 `<conversationId>:<runId>:card`，封版降级是 `<conversationId>:<runId>:seal`。
6. `pushedSeq` 只在发送成功并确认终态后推进；重试耗尽抛错，游标停在未投递条目之前。
7. 同一个 agent 同时只有一个 lark-bot 进程（PID 锁）。

## 已知缺口

- `surface.control` 的重绑路径没有生产触发入口：`POST /api/conversations/:id/start-new` 目前只有测试调用，旧的触发工具已不存在。路由与端侧消费都已具备。
- `diagnostics.ts` 里的 `runStreams` 字段是 API 兼容空桩，统计恒为 0，对应的表已经从本地 schema 删除。
- 群聊的 @ 检测依赖 `botDisplayName`，缺了就只有单聊可用。
- 出站没有回执：投递成功与否只体现在 lark-cli 的退出码上。
- 卡片交互只有 `/stop` 命令与 Web 深链：reaction 触发（`im.message.reaction.created_v1`）与卡片按钮回调（`card.action.trigger`，lark-cli 的 event 目录没有）都未实现，见 ADR 0031 决策 6。
- 审批与追问在卡片上只有「等待」状态展示，没有卡片内表单（回答仍需 Web 端），等回调通道解决后是第二期。

## 相关页

- [端总览](./overview.md)
- [飞书消息端到端](../flows/e2e-lark-message.md)
- [Conversation History](../conversation/history.md)
- [排障指南](../operations/troubleshooting.md)
