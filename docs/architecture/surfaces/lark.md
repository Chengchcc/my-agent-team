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
- `apps/lark-bot/src/run-card/` — Run 卡片：`card-kit.ts`（直连 CardKit 的 fetch 客户端）、`card-state.ts`（事件→状态的纯 reducer）、`card-renderer.ts`（Card JSON 2.0 + streaming_mode）、`card-flush.ts`（单飞 flush 控制器）、`card-actions.ts`（`card.action.trigger` 回调的解析、校验与执行）、`run-card-watcher.ts`（生命周期与终态封版）
- `apps/lark-bot/scripts/probe-cards.ts` — 把真实渲染出的每种卡片 POST 给建卡接口，做线级校验（不给任何聊天发消息）
- `apps/lark-bot/src/lark-api.ts` — tenant token：从 lark-cli 本地密钥库解出 appSecret 自行铸造并缓存
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
3. **绑定解析（话题 = 会话，ADR 0037）**：会话的边界是飞书**话题**，不是聊天。从事件取 `thread_id`／`root_id`（两者都由平台给出，实测见 ADR 0037）依次查 `topic_binding`：命中就续接该会话；都没命中说明这条消息**开了新话题**，返回 `needCreateConv`。`member_binding` 缺失时现写一条 `human:lark:<open_id>`。
4. **建会话**：只有 `needCreateConv` 时调 `POST /api/conversations {agentId}`。随后写 `conversation_binding`（会话 → 聊天，带自己的推送游标与聊天模式）与 `topic_binding`（本话题的所有键 → 该会话），没有成员相关的 HTTP 调用，后端也没有成员表。
5. **路由**：单聊不传 `senderMemberId` 与 `addressedTo`，由服务端派生成 sender 与 target；群聊传 `senderMemberId`，`addressedTo` 在 `botDisplayName` 存在且 `isBotMentioned` 命中时为 `[selfAgentId]`，否则为 `[]`。缺 `botDisplayName` 时群聊 fail-closed，只能单聊。
6. **POST 消息**：`content` 就是**消息文本本身**（字符串）。曾经包成 `{ text, source, larkEventId, larkMessageId }` 信封——后端写入方只认字符串或 ContentBlock 数组，于是文本被静默丢弃、每条飞书消息都变成空轮次，模型只能拿旧上下文编；那三个额外字段也没有任何读取方。接口返回 202 与 `{ seq, triggeredRuns }`。
7. **确认**：`confirmInbound` 回填 `conversationId` 与 `ledgerSeq`。POST 之前进程崩掉的话，这条入站不会再被处理。

## 本地五张表

`apps/lark-bot/src/db/schema.ts` 里的表都是这个端私有的投递状态，不进后端：

| 表 | 主键 | 用途 |
|---|---|---|
| `conversation_binding` | `conversation_id` | 会话 → 飞书 chat，带**按会话**的 `pushed_seq` 推送游标、`chat_mode`（话题群回复要 `reply_in_thread`）与 `topic_root_message_id`（本话题的根消息，回答一律回复它） |
| `topic_binding` | `(lark_chat_id, topic_key)` | 话题键 → 会话：键是话题群的话题线程 `omt_…`，或一条消息 `om_…`（用户开的顶层消息／我们发出、用户会去回复的那条）。一个会话可有多个键（私聊回复链先给 `root_id`，第二次回复才拿到 `thread_id`，两者必须指向同一会话） |
| `member_binding` | `(lark_chat_id, lark_open_id)` | 飞书用户 → 本地 memberId 标签，形如 `human:lark:<open_id>` |
| `inbound_message` | `lark_event_id` | 入站幂等，`lark_message_id` 上另有唯一约束 |
| `message_delivery` | `(conversation_id, message_id, lark_chat_id)` | 文本桥出站投递意图与最后状态 |
| `input_card` | `input_id` | 排队消息的卡片状态（`queued / promoted / cancelled`，ADR 0037） |
| `run_card` | `run_id` | Run 卡片投递状态：lark 消息 id、状态机、累计输出、失败计数（ADR 0031） |

## 出站

每个会话一个 watcher（启动时按 `conversation_binding` 全量恢复；新话题开新会话时经 `onNewBinding` 补一个）。请求是 `${backendUrl}/api/conversations/:id/events?afterSeq=<pushedSeq>`，游标大于 0 时另带 `Last-Event-ID`。连接失败 5 秒后重试，流正常结束 1 秒后重试。每帧用 `ConversationEvent.parse` 严格校验；SyntaxError 与 ZodError 只打日志并跳过，其它异常重新抛出让连接重连。

`processEntry` 的过滤链顺序固定：

1. `seq <= currentSeq` 的帧直接丢弃，只保证不重复处理。
2. `surface.control` 交给重绑分支处理。
3. 非 `message` 帧、没有 `message` 的帧、`role === "system"`、`role === "user"`、`role === "tool"` 的行只推进游标。人类自己的话已经在飞书里，不需要回显；工具行的原始输出不进群聊（摘要属于 Run 卡片，见 ADR 0031）。
4. 查 `message_delivery`，命中且 `isTerminalMessageState(lastState)` 就推进游标跳过。
5. 先以非终态标记（`streaming`）写投递意图，再渲染发送；发送成功后才写终态确认并推进 `pushedSeq`。

canonical 账本只有终态行：`state` 只有 `done` 与 `error` 两种取值，所以飞书没有流式渲染路径，每个 assistant 行只投递一次。

出站只有**一条**路径：`apps/lark-bot/src/topic-send.ts` 的 `sendIntoTopic()`。桥接投递（`onSend`）、卡片失败时的回退文本、控制回复（`/stop` 回执、未知命令）全部经由它——因为「发到群里」不等于「发进话题」：在话题群里，一条顶层消息**就是开一个新话题**。只教会其中一条路径的后果真实发生过：控制回复进了话题，而每一条回答都在群里散成独立话题。

底层命令是 `im +messages-reply --message-id <话题根>`（话题群再加 `--reply-in-thread`，普通聊天会拒绝这个标志，所以由会话记录的 `chat_mode` 决定），拿不到回复目标时才退回 `im +messages-send`，幂等键 `<conversationId:messageId:seq>`。发送成功后把这条消息的 id（以及平台分配的 `thread_id`）登记为话题键，于是「用户回复这条消息」也认得出该会话，出问题的那条也还能撤回。**回答与问题同处一个话题**是 ADR 0037 的可见结果。

话题的**根**由会话记录（`conversation_binding.topic_root_message_id`），不由键推断——一个会话有多个键，而 `omt_…` 根本不能作为回复目标，根却是唯一的一条消息。根为 NULL 的旧会话由 `ensureTopicRoot()` 自愈（取该聊天里最早登记的 `om_` 键），所以升级后老会话的下一条回答也会回到自己的话题里：

- **话题群**：根是「开这个话题的那条消息」（它自带 `thread_id`），回答回复它并带 `reply_in_thread`，卡片就落在话题里。
- **私聊**：没有任何东西开话题，所以我们**主动创建**——回答用 `reply_in_thread` **回复用户那条消息**（实测该请求直接返回 `thread_id`），话题的根就是用户那条消息，卡片落在话题里。此后用户在该话题内回复即续接；在话题外发新消息则是新话题、新会话。（不做这一步的话，私聊里连话题都不会出现。）失败退避重试 3 次（500ms 乘 2 的幂），耗尽后抛错断开本连接，重连后从游标重放该条并以同一幂等键重发（Lark 侧去重）；语义是 at-least-once（ADR 0032）。

## Run 卡片（ADR 0031 第一期）

ingest 拿到 `triggeredRuns` 后立刻为每个 run 建 CardKit 卡片实体并发送引用消息，状态机 `creating → streaming → waiting → completed | failed | cancelled | fallback_text`。**loop 事件先归并成运行视图、绝不直接映射**：`thinking_delta` 只产生阶段词（原始推理永不进 Lark）、`text_delta` 是唯一逐字流（主输出区）、工具事件折叠成「当前动作 + 已完成步骤」摘要（结果按 `result.isError` 判成败，原始输入输出留在 Web）、`approval_request` 携带 callId 切换审批帧。**热路径直连 CardKit OpenAPI**（`run-card/card-kit.ts`，纯 fetch）；tenant token 由 `lark-api.ts` 从 lark-cli 本地密钥库解出 secret 自行铸造并缓存——lark-cli 只保留 profile 管理、入站事件与普通文本发送。

oma 产品工具（todo、ask、approval）在飞书端**不重新解释**：backend 注入、执行、鉴权后以标准 Run SSE 事件下发，卡片只是投影的一环。`backend.oma.todo_update` 的计划条渲染进过程区（最近 5 条，`done` ✓ / `in_progress` ● / `cancelled` ✗ / `pending` ○）；`backend.oma.ask_requested` 把第一题解析成 `pendingAction`（题面 + 选项 + 是否允许自由输入），活卡据此把「停止」换成选项按钮。**todo 状态词表属于生产方（oma todo 插件：`pending | in_progress | done | cancelled`），卡片不得自造词表**——两端的形状定义收敛在 `packages/api-contract/src/sse.ts` 的 `OmaTodoItem`（Web reducer 同样复用），`done` 曾被卡片侧误写成 `completed` 而整条丢失。

工具步骤那行显示的是**子进程自己声明的活动**（`native_tool_started.activity`，由 oma 的 `Tool.describeStart` 产出并清洗过，见 [Oma Tools](../runtime/oma-tools.md#活动描述工具自己声明)），不是卡片从工具名猜出来的摘要——早先那版把 `bash` 映射成「执行命令」、`read` 映射成「读取文件」，那是在声称自己知道工具在做什么。没有 `activity` 时只显示 `正在调用 <名字>`（MCP 名字读作 `server · tool`）。有专用事件的产品工具（`todo_write`、`ask_question`）不进过程条：判断走 `api-contract` 的 `hasDedicatedEvent()`，**按叶子名匹配**——线上名字是全限定的 `mcp__product-tools__todo_write`（backend workspace-bridge 写进 `.mcp.json`、oma `mcp-mount.ts` 拼成 `mcp__<server>__<tool>`），直等裸名永远不命中，这个坑先踩在 Web 的四处过滤上、又踩在飞书首版上。

- **传输分层（决策 9）**：正文逐字 = `PUT /cards/:id/elements/:element_id/content`（累计全文 + 严格递增 `card_seq`，客户端对前缀扩展做打字机动画；正文/过程条/状态行三个元素各自只推变化）；header 变化与终态 = 全卡替换 `PUT /cards/:id`（流式元素改不了 header，也是按钮集变化的唯一途径）；终态替换后必须 `PATCH /cards/:id/settings` 关闭 streaming_mode，客户端才离开流式视图。
- **节流与节拍**：150ms/120 字符合并、单飞 flush（互斥 + 补刷 + 只推变化元素）；另有一个 1 秒状态节拍器，保证「耗时 N 秒」在模型思考/工具运行期间也每秒跳动（内容没变就不发请求）。
- **终态封版**：`GET /api/agent-runs/:runId` 的 `terminalResult.messages` 取最后一条带文本的 assistant 消息（与账本提交同源），重试 3 次等落库；封版替换失败降级为发送最终纯文本（`larkIdempotencyKey` 哈希键）并把卡标 `fallback_text`。
- **与文本桥的去重缝（决策 8）**：assistant 行的 messageId 形如 `run:<runId>:assistant:<n>`，sse-watcher 投递前解析它——该 (runId, chat) 的卡片存在且不是 `fallback_text` 就跳过文本发送；卡片从创建起拥有投递权，失败即 `fallback_text` 交还文本桥。
- **控制（决策 6，已实现）**：活卡带红色「停止」按钮（`behaviors:[{type:"callback",value:{runId,action:"stop"}}]`）；`waiting` 帧把按钮换成「批准/拒绝」（`action:"approve" | "reject"` + callId）或问答题的选项按钮（`action:"answer_ask"` + callId、questionId、selectedValue）。点击经 lark-cli ≥1.0.9x 的 `card.action.trigger` 长连接回调 → `run-card/card-actions.ts` 校验（event_id 去重、message↔run_card 映射、chat/run 匹配，action_value 永不单独被信任）→ 停止走 `POST /api/agent-runs/:runId/cancel`，审批走 `.../approval`，追问走 `POST /api/product-tools/ask/resolve`（**与 Web 同一条 resolve 路径，两端各渲染一次而已**）→ Run SSE 的对应事件清掉 `pendingAction`，终态封版。`/stop` 入站命令为等价通道，成功即沉默（卡片即反馈）。
- **回调载荷形状**：lark-cli 把事件摊平成顶层 snake_case 键（`event_id`/`operator_id`/`chat_id`/`message_id`/`action_tag`/`action_value`），不是 Lark 原始 schema 的 `action.value`——`card-actions.ts` 按这个形状取值，测试 fixture 也照此构造。
- **正文窗口**：最近约 10k 字符，头部折叠提示去 Web（`--web-url`/`LARK_WEB_URL`，Markdown 链接形态）。
- **幂等键**：飞书 `--idempotency-key` 有 **50 字符上限**（99992402），自然键天然超限，统一 `larkIdempotencyKey()` 哈希成 40 位十六进制。
- **重启恢复**：启动读回非终态 `run_card` 行（含 `card_kit_id` 与 `card_seq`）继续驱动；Run SSE 晚订阅语义保证已结算 run 立即给终态。
- **配额警示**：每应用**卡片实体绑定数有配额**（错误 200780，实测约 18 张触发）；高频部署需关注，或为超配额场景保留 IM-patch 降级路径。

## 排队卡片（ADR 0037：一轮 = 一张卡）

一条消息如果落在**正在跑的那一轮**之后，它不会并进当前轮（端侧 POST 消息固定带 `mode: "normal"`，后端在有活跃 run 时一律排队），而是**自己得到一张卡**：卡片头写「排队中」，正文说明「上一轮还在跑，这条消息在排队」，并带一个**取消这条**按钮。

- 取消只取消这条消息（`POST /api/conversations/:id/inputs/:inputId/cancel`），正在跑的那一轮不受影响——就是「取消 steer」的语义。
- 轮询 `GET /api/conversations/:id/inputs`：该输入被提升成新 run（后端会把 `run_id` 回写到排队行）时，**同一张卡片**接管那一轮（`watchRunCard` 的 `adopt`：复用既有 CardKit 实体与消息 id，首次 flush 整卡替换成运行中的卡），所以一个消息永远只有一张卡。
- 卡片自己的消息 id 与它拿到的话题 id 也登记进 `topic_binding`（用户可能在它排队时回复它）。
- 排队卡片的记录在 `input_card` 表（`queued → promoted | cancelled`），取消回调按「回调的 message_id 必须就是承载该输入卡片的那条、且 chat 一致」校验。

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
8. 一个飞书话题 ↔ 一个会话，且一个聊天内可以有多个会话；`pushed_seq` 属于会话而非聊天（ADR 0037）。**群里**的话题内仍然要求 @ 机器人（话题下可能有其他人交流）；**私聊不要求**——私聊本身就是点名，用户「在话题里回复」是续问的唯一动作，再要求 @ 就等于把这条动作废掉。
9. 卡片 JSON 必须过飞书的线级校验，三条踩过的规则：`form` 容器**至少含一个 submit 按钮**（否则 300123，整卡被拒，所以选项按钮不进 form）；`element_id` 只能 ASCII 字母开头、字母数字下划线、**≤20 字符**（300301，所以选项按钮用位置 id `ask_opt_<i>`，不拿选项值拼）；元素内容更新要求目标元素**已存在**（300313，所以 Run 卡的 activity/answer/tools/status 永远渲染，空内容也渲染）。
10. 改渲染器后跑一次 `bun apps/lark-bot/scripts/probe-cards.ts <profile>`：它把真实渲染结果 POST 给建卡接口（不给任何聊天发消息），把只有线上才暴露的拒绝变成几秒的本地检查。会占少量卡片实体配额（应用级，且平台没有删除接口），所以是改渲染器后的动作，不是每次提交的门禁。
11. 卡片连败三次进降级（停止绘制），但**待回答的问题仍重试一次**（按问题 callId 记一次），成功后恢复绘制——降级不能让一个提问变成没人能回答的僵尸。
12. 带交互元素的卡（追问/批准）不要混排**容器**（`collapsible_panel`）、也不要给按钮加 `width: "fill"`：建卡接口都放行，但真机点击会被客户端拒绝（2026-09-25：同一张卡的停止按钮能点、选项按钮报错）。进度在这种情况下用扁平 markdown，选项对齐靠参考实现的 `column_set`（左列文字 + 右列固定文案按钮，等宽自然对齐）。

## 已知缺口

- `surface.control` 的重绑路径没有生产触发入口：`POST /api/conversations/:id/start-new` 目前只有测试调用，旧的触发工具已不存在。路由与端侧消费都已具备。
- `diagnostics.ts` 里的 `runStreams` 字段是 API 兼容空桩，统计恒为 0，对应的表已经从本地 schema 删除。
- 群聊的 @ 检测依赖 `botDisplayName`，缺了就只有单聊可用。
- 出站没有回执：投递成功与否只体现在 lark-cli 的退出码上。
- 卡片交互只差 reaction 触发（`im.message.reaction.created_v1`，lark-cli 的 event 目录没有）。按钮回调（`card.action.trigger`）已实现，见 ADR 0031 决策 6 的 2026-09-24 修订。
- 多选（`multi`）追问只按单选取值，卡片渲染不出多选控件。自由文本追问走 form（`input` + submit，`form_value` 一次性回传），选择题走整行按钮（`width: fill`），`allowOther` 的选择题也接受话题文字作答。
- 回调只做了单操作者的防重放（event_id 去重 + message↔run_card 映射）。签名 action token 与 backend 侧事件去重留给多操作者场景。
- 工具步骤那行依赖子进程声明活动（`describeStart`）：omp 后端至今不给（`adapter-omp-agent` 只带 `toolName`/`toolCallId`），所以 omp Run 永远只显示工具名；外部 MCP 工具同理，除非它自己声明。
- `native_tool_started.activity` 会随 telemetry 落进 `agent_run_event`（按事件名白名单），也就是活动行进库；目前没有保留期清理。

## 相关页

- [端总览](./overview.md)
- [飞书消息端到端](../flows/e2e-lark-message.md)
- [Conversation History](../conversation/history.md)
- [排障指南](../operations/troubleshooting.md)
