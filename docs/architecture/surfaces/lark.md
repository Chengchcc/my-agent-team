---
title: 飞书端
description: 飞书入站的鉴权与幂等占位、本地五张表，Run 流式卡片（ADR 0031），以及 AHP watcher 的出站判定、卡片去重缝与投递去重
tags: [lark, surfaces, backend]
---

# 飞书端

一句话：本页是飞书端的权威描述。飞书端是 lark-bot 进程。入站把飞书群与单聊的消息 POST 给 backend 的 conversation API（`/stop` 控制命令除外，它直接调 Run 取消接口）。出站有两条：Run 流式卡片（ADR 0031，由 AHP chat 状态驱动的 transient 投影，终态以 canonical 文本封版）与 AHP watcher 的会话文本（订阅 chat 频道，卡片不拥有投递时的兜底通道）。两条读的是同一份事实：每份 chat 状态投递完再转给跑动卡（`onChatState`）。工具行不投递，卡片上只显示工具摘要。

## 范围

覆盖：入站管线的每一步（鉴权、幂等占位、绑定、路由、POST、/stop），本地九张表，Run 卡片生命周期，出站的过滤链、卡片去重缝、去重模型、重试与推送游标，内容渲染与截断，surface.control 重绑，进程生命周期与 backend 侧的接线，以及 Web 侧的每 chat 策略编辑。

不覆盖：backend 侧的触发与执行（见 [飞书消息端到端](../flows/e2e-lark-message.md)）、Web 端（见 [Web 端](./web.md)）、lark-cli 与飞书开放平台的协议细节（本页只讲到进程怎么起）。

## 实现文件

- `apps/lark-bot/src/main.ts` — 起官方 channel SDK 的长连接、注册 message / cardAction / comment 三个处理器、watcher 表、重绑、心跳、退出处理
- `apps/lark-bot/src/channel-adapters.ts` — 边界适配：`NormalizedMessage → LarkMessageEvent`、`CardActionEvent → 卡片行`、`CommentEvent → CommentTrigger`
- `apps/lark-bot/src/{comment-scope,comment-body,doc-subscription,ingest-comment}.ts` — 评论线的合成身份、正文抽取、按文档订阅、评论侧 ingest
- `apps/lark-bot/src/ingest.ts` — 入站主管线与 `/stop` 控制命令
- `apps/lark-bot/src/bindings-sqlite.ts` — 七张表的读写与 `rebindChatConversation`
- `apps/lark-bot/src/run-card/` — Run 卡片：`card-kit.ts`（直连 CardKit 的 fetch 客户端）、`card-state.ts`（从 chat 状态读出卡片状态的纯函数）、`card-renderer.ts`（Card JSON 2.0 + streaming_mode）、`card-flush.ts`（单飞 flush 控制器）、`card-actions.ts`（`card.action.trigger` 回调的解析、校验与执行）、`run-card-watcher.ts`（生命周期与终态封版）
- `apps/lark-bot/scripts/probe-cards.ts` — 把真实渲染出的每种卡片 POST 给建卡接口，做线级校验（不给任何聊天发消息）
- `apps/lark-bot/src/lark-api.ts` — tenant token：从 lark-cli 本地密钥库解出 appSecret 自行铸造并缓存
- `apps/lark-bot/src/ahp-watcher.ts` 与 `ahp-delivery.ts` — 出站：AHP 连接、按 chat 状态判定投递、续接改绑；每份状态投递完再转给跑动卡（`onChatState`），卡片和文本读的是同一份事实
- `apps/lark-bot/src/markdown-normalizer.ts` — 行到文本的换行与截断（跑动卡的渲染仍在用）
- `apps/lark-bot/src/sender.ts` 与 `send-text-only.ts` — 经 lark-cli 投递
- `apps/lark-bot/src/{bootstrap,args,event-parser,client,safe-agent-id,diagnostics}.ts` — 启动、参数、事件解析、treaty 客户端、id 安全化、心跳
- `apps/lark-bot/src/db/schema.ts` 与 `apps/lark-bot/drizzle/` — 本地 schema 与迁移
- `apps/backend/src/features/agent/{agent-config.ts,agent-lark.ts,http.ts}` — 配置字段与生命周期包装
- `apps/backend/src/features/lark-bot/{registry,profile,setup-manager,provisioner}.ts` — 进程的起停

## 入站

进程用官方 `@larksuite/channel` 的长连接收事件（ADR 0044）：`createLarkChannel({appId, appSecret})` 的凭据来自 lark-cli 的本地密钥库（`lark-cli` 仍是建 app 与凭据的权威源），`channel.on({message, cardAction, comment})` 三个处理器各自把 SDK 的归一化对象交给 `channel-adapters.ts` 的适配器，之后完全沿用既有的管线。**同一个 app 只能有一条连接**（cluster 模式不广播，多开会随机丢事件），所以 `lark-cli` 的 `event consume` 已彻底下线。每条事件的流水线是 reserve → POST → confirm：

1. **鉴权**（`ingest.ts`）：`sender_type` 存在且不是 `"user"` 直接 skip，防机器人互相触发；再按 `agent.lark.allowedSenders`（open_id 白名单）过滤。**空白名单是拒绝，不是放行**（`matchesAllowlist` 对空数组返回 false，DM 里落 `dm_denied`）；只有显式写 `"*"` 才放行所有人。Web 的读模型按同一语义显示为 `allowlist`（0 人）与 `everyone`。
2. **幂等占位**：`inboundExists` 按 `event_id` 或 `message_id` 命中即 skip，否则 `reserveInbound` 在同一事务里落一行 `status = "processing"`。占位先于 POST，取舍是宁可丢一条入站也不重复触发 run。
3. **绑定解析（话题 = 会话，ADR 0037）**：会话的边界是飞书**话题**，不是聊天。从事件取 `thread_id`／`root_id`（两者都由平台给出，实测见 ADR 0037）依次查 `topic_binding`：命中就续接该会话；都没命中说明这条消息**开了新话题**，返回 `needCreateConv`。`member_binding` 缺失时现写一条 `human:lark:<open_id>`。
4. **建会话**：只有 `needCreateConv` 时调 `POST /api/conversations {agentId}`。随后写 `conversation_binding`（会话 → 聊天，带自己的推送游标与聊天模式）与 `topic_binding`（本话题的所有键 → 该会话），没有成员相关的 HTTP 调用，后端也没有成员表。
5. **路由**：单聊不传 `senderMemberId` 与 `addressedTo`，由服务端派生成 sender 与 target；群聊传 `senderMemberId`，`addressedTo` 在 `botDisplayName` 存在且 `isBotMentioned` 命中时为 `[selfAgentId]`，否则为 `[]`。缺 `botDisplayName` 时群聊 fail-closed，只能单聊。
6. **POST 消息**：`content` 就是**消息文本本身**（字符串）。曾经包成 `{ text, source, larkEventId, larkMessageId }` 信封——后端写入方只认字符串或 ContentBlock 数组，于是文本被静默丢弃、每条飞书消息都变成空轮次，模型只能拿旧上下文编；那三个额外字段也没有任何读取方。接口返回 202 与 `{ seq, triggeredRuns }`。每条消息都带 `source: { kind: "lark", chatId }`（ADR 0046）：后端的环境规则靠它做 chat 级 scoping——observe 消息（`addressedTo: []`）命中 act 规则时会被升格为任务并在返回的 `triggeredRuns` 里出现，bot 的卡片路径对此不需要任何特判。
7. **确认**：`confirmInbound` 回填 `conversationId` 与 `ledgerSeq`。POST 之前进程崩掉的话，这条入站不会再被处理。

### 评论线（ADR 0044）

云文档评论是第二个「会话边界」，与话题同构：**一条评论线（文档 + 一个评论串）= 一个会话**，回答**回复进同一条评论线**（绝不新开顶层评论）。它与上面那条管线的差别：

- **触发**：官方 SDK 的 `comment` 事件（`drive.notice.comment_add_v1`，`lark-cli` 的总线订阅不到它）。通知**只带 id 不带正文** ⇒ 用 `comments.fetch` 取，取哪一条由通知的 `replyId` 决定（`comment-body.ts` 是这一步的纯函数）。
- **两重闸门**：只认 `mentionedBot`；`notice_meta.is_from_agent === true` 一律不答。实测 bot 给自己文档评论**不产生通知**，所以第二道是给「agent 互相评论」准备的，不是当初收不到的原因。
- **按文件订阅**：云文档事件是**按文件**的，第一次见到某文档时调 `POST /files/:file_token/subscribe?file_type=<type>`（`file_type` 在**查询串**，放 body 报 `field validation failed`），订阅状态落 `comment_subscription`。
- **合成身份**：评论会话在 `conversation_binding` 里的 chat id 是 `comment:<file_token>:<comment_id>`（`comment-scope.ts`）⇒ 游标、投递台账、幂等键、AHP watcher 全部照旧，只有发送那一步认得它（走 `comments.reply`）。
- **去重身份是「通知」而不是「评论」**：同一条评论线里的后续回复各有自己的 `event_id` / `reply_id`，用 `(fileToken, commentId)` 去重会把它们吞掉。
- **产物**：评论回复只能带文本元素，图片在 v1 **明确回一句「无法投递」**，不假装送达。
- **控制台三个前提**（缺任何一个都是**静默**）：`im.message.receive_v1`、`card.action.trigger`、`drive.notice.comment_add_v1`，外加文档相关 scope。`larkSetupGuidance`（`features/lark-bot/setup-guidance.ts`）给出清单与 `scope-apply` 链接，挂在 surface 视图的 `console` 字段上，Web 面板已经在渲染（`apps/web/src/features/lark/LarkSurfacePanel.tsx`）。

## 本地九张表

`apps/lark-bot/src/db/schema.ts` 里的表都是这个端私有的投递状态，不进后端：

| 表 | 主键 | 用途 |
|---|---|---|
| `conversation_binding` | `conversation_id` | 会话 → 飞书 chat，带 `chat_mode`（话题群回复要 `reply_in_thread`）与 `topic_root_message_id`（本话题的根消息，回答一律回复它） |
| `topic_binding` | `(lark_chat_id, topic_key)` | 话题键 → 会话：键是话题群的话题线程 `omt_…`，或一条消息 `om_…`（用户开的顶层消息／我们发出、用户会去回复的那条）。一个会话可有多个键（私聊回复链先给 `root_id`，第二次回复才拿到 `thread_id`，两者必须指向同一会话） |
| `member_binding` | `(lark_chat_id, lark_open_id)` | 飞书用户 → 本地 memberId 标签，形如 `human:lark:<open_id>` |
| `inbound_message` | `lark_event_id` | 入站幂等，`lark_message_id` 上另有唯一约束 |
| `message_delivery` | `(conversation_id, message_id, lark_chat_id)` | 文本桥出站投递意图与最后状态 |
| `input_card` | `input_id` | 排队消息的卡片状态（`queued / promoted / cancelled`，ADR 0037） |
| `run_card` | `run_id` | Run 卡片投递状态：lark 消息 id、状态机、累计输出、失败计数（ADR 0031） |
| `comment_binding` | `conversation_id` | 评论线 → 会话（ADR 0044）：文档 token、类型与评论 id，`(file_token, comment_id)` 上唯一；会话在 `conversation_binding` 里的 chat id 是合成的 `comment:<file_token>:<comment_id>` |
| `comment_subscription` | `file_token` | 已向平台订阅事件（`drive.notice.comment_add_v1`）的文档：云文档事件是**按文件**的，重启后既不能盲订也不能忘 |

## 出站

每个会话一个 watcher（启动时按 `conversation_binding` 全量恢复；新话题开新会话时经 `onNewBinding` 补一个）。watcher 先取一次性票据，再用共享传输连上 `/ws/ahp`，`initialize` 拿 chat 快照、`attachSubscription` 拿动作流，上游 `chatReducer` 把动作折进状态，然后交给 `deliverChatState` 判定该发什么。断线只要重订阅，投递表本身回答了「发过什么」，没有游标要续。

`deliverChatState` 按片段类型决定发什么，顺序固定：

1. `markdown` 片段才可能发文本；人类自己的行不在账本里当片段，工具行的原始输出不进群聊（摘要属于 Run 卡片，见 ADR 0031）。
2. 取片段的 `_meta.messageId`，那是账本行的身份；没有它或正文为空就跳过。
3. assistant 行的 messageId 形如 `run:<runId>:assistant:<n>`，解析出 runId 后查这一 (runId, chat) 的卡片：卡片拥有投递权时不发文本，由卡片封版（ADR 0031 第 8 节）。
4. 查 `message_delivery`，命中且 `isTerminalMessageState(lastState)` 就跳过，重放因此幂等。
5. 先以非终态标记（`streaming`）写投递意图，再发送；发送成功写终态确认。
6. `systemNotification` 片段交给续接分支（见下）。

canonical 账本只有终态行：`state` 只有 `done` 与 `error` 两种取值，所以飞书没有流式渲染路径，每个 assistant 行只投递一次。

出站只有**一条**路径：`apps/lark-bot/src/topic-send.ts` 的 `sendIntoTopic()`。桥接投递（`onSend`）、卡片失败时的回退文本、控制回复（`/stop` 回执、未知命令）全部经由它——因为「发到群里」不等于「发进话题」：在话题群里，一条顶层消息**就是开一个新话题**。只教会其中一条路径的后果真实发生过：控制回复进了话题，而每一条回答都在群里散成独立话题。

底层命令是 `im +messages-reply --message-id <话题根>`（话题群再加 `--reply-in-thread`，普通聊天会拒绝这个标志，所以由会话记录的 `chat_mode` 决定），拿不到回复目标时才退回 `im +messages-send`，幂等键 `<conversationId:messageId:seq>`。发送成功后把这条消息的 id（以及平台分配的 `thread_id`）登记为话题键，于是「用户回复这条消息」也认得出该会话，出问题的那条也还能撤回。**回答与问题同处一个话题**是 ADR 0037 的可见结果。

话题的**根**由会话记录（`conversation_binding.topic_root_message_id`），不由键推断——一个会话有多个键，而 `omt_…` 根本不能作为回复目标，根却是唯一的一条消息。根为 NULL 的旧会话由 `ensureTopicRoot()` 自愈（取该聊天里最早登记的 `om_` 键），所以升级后老会话的下一条回答也会回到自己的话题里：

- **话题群**：根是「开这个话题的那条消息」（它自带 `thread_id`），回答回复它并带 `reply_in_thread`，卡片就落在话题里。
- **私聊**：没有任何东西开话题，所以我们**主动创建**——回答用 `reply_in_thread` **回复用户那条消息**（实测该请求直接返回 `thread_id`），话题的根就是用户那条消息，卡片落在话题里。此后用户在该话题内回复即续接；在话题外发新消息则是新话题、新会话。（不做这一步的话，私聊里连话题都不会出现。）失败退避重试 3 次（500ms 乘 2 的幂），耗尽后抛错断开本连接，重连后从游标重放该条并以同一幂等键重发（Lark 侧去重）；语义是 at-least-once（ADR 0032）。

## Run 卡片（ADR 0031 第一期）

ingest 拿到 `triggeredRuns` 后立刻为每个 run 建 CardKit 卡片实体并发送引用消息，状态机 `creating → streaming → waiting → completed | failed | cancelled | fallback_text`。**卡片的来源是 chat 状态里的那一轮，那条 Run 流不再有消费者**（ADR 0040）：run 就是它的 turn，markdown 片段是唯一逐字流（主输出区），工具调用片段折叠成「当前动作 + 已完成步骤」摘要（成败看片段的 `success`，原始输入输出留在 Web），还没答复的 `inputRequest` 片段就是按钮，`_meta.todos` 是计划条；推理片段永不进 Lark，用阶段词代替。turn 折进 `turns` 即封版。**热路径直连 CardKit OpenAPI**（`run-card/card-kit.ts`，纯 fetch）；tenant token 由 `lark-api.ts` 从 lark-cli 本地密钥库解出 secret 自行铸造并缓存——lark-cli 只保留 profile 管理、入站事件与普通文本发送。

oma 产品工具（todo、ask、approval）在飞书端**不重新解释**：backend 注入、执行、鉴权后由投影带进 chat 状态，卡片只是投影的一环。`_meta.todos` 的计划条渲染进过程区（最近 5 条，`done` ✓ / `in_progress` ● / `cancelled` ✗ / `pending` ○）；未答复的 `inputRequest` 片段把第一题解析成 `pendingAction`（题面 + 选项 + 是否允许自由输入），活卡据此把「停止」换成选项按钮；产品 payload 挂在片段的 `_meta.productRequest` 上，那是本仓库的约定，上游 `ChatInputRequest` 没有这个槽。**todo 状态词表属于生产方（oma todo 插件：`pending | in_progress | done | cancelled`），卡片不得自造词表**——两端的形状定义收敛在 `packages/api-contract/src/sse.ts` 的 `OmaTodoItem`（Web reducer 同样复用），`done` 曾被卡片侧误写成 `completed` 而整条丢失。

工具步骤那行显示的是**子进程自己声明的活动**（协议里是工具调用片段的 `intention`，也就是 oma 的 `Tool.describeStart` 产出并清洗过的活动串；它缺席时才读协议放在调用上的 `invocationMessage`，见 [Oma Tools](../runtime/oma-tools.md#活动描述工具自己声明)），不是卡片从工具名猜出来的摘要——早先那版把 `bash` 映射成「执行命令」、`read` 映射成「读取文件」，那是在声称自己知道工具在做什么。没有 `activity` 时只显示 `正在调用 <名字>`（MCP 名字读作 `server · tool`）。有专用事件的产品工具（`todo_write`、`ask_question`）不进过程条：判断走 `api-contract` 的 `hasDedicatedEvent()`，**按叶子名匹配**——线上名字是全限定的 `mcp__product-tools__todo_write`（backend workspace-bridge 写进 `.mcp.json`、oma `mcp-mount.ts` 拼成 `mcp__<server>__<tool>`），直等裸名永远不命中，这个坑先踩在 Web 的四处过滤上、又踩在飞书首版上。

- **传输分层（决策 9）**：正文逐字 = `PUT /cards/:id/elements/:element_id/content`（累计全文 + 严格递增 `card_seq`，客户端对前缀扩展做打字机动画；正文/过程条/状态行三个元素各自只推变化）；header 变化与终态 = 全卡替换 `PUT /cards/:id`（流式元素改不了 header，也是按钮集变化的唯一途径）；终态替换后必须 `PATCH /cards/:id/settings` 关闭 streaming_mode，客户端才离开流式视图。
- **节流与节拍**：150ms/120 字符合并、单飞 flush（互斥 + 补刷 + 只推变化元素）；另有一个 1 秒状态节拍器，保证「耗时 N 秒」在模型思考/工具运行期间也每秒跳动（内容没变就不发请求）。
- **终态封版**：`GET /api/agent-runs/:runId` 的 `terminalResult.messages` 取最后一条带文本的 assistant 消息（与账本提交同源），重试 3 次等落库；封版替换失败降级为发送最终纯文本（`larkIdempotencyKey` 哈希键）并把卡标 `fallback_text`。
- **与文本桥的去重缝（决策 8）**：assistant 行的 messageId 形如 `run:<runId>:assistant:<n>`，`ahp-delivery` 投递前解析它——该 (runId, chat) 的卡片存在且不是 `fallback_text` 就跳过文本发送；卡片从创建起拥有投递权，失败即 `fallback_text` 交还文本桥。
- **控制（决策 6，已实现）**：活卡带红色「停止」按钮（`behaviors:[{type:"callback",value:{runId,action:"stop"}}]`）；`waiting` 帧把按钮换成「批准/拒绝」（`action:"approve" | "reject"` + callId）或问答题的选项按钮（`action:"answer_ask"` + callId、questionId、selectedValue）。点击经 lark-cli ≥1.0.9x 的 `card.action.trigger` 长连接回调 → `run-card/card-actions.ts` 校验（event_id 去重、message↔run_card 映射、chat/run 匹配，action_value 永不单独被信任）→ 停止走 `POST /api/agent-runs/:runId/cancel`，审批走 `.../approval`，追问走 `POST /api/product-tools/ask/resolve`（**与 Web 同一条 resolve 路径，两端各渲染一次而已**）→ Run SSE 的对应事件清掉 `pendingAction`，终态封版。`/stop` 入站命令为等价通道，成功即沉默（卡片即反馈）。
- **回调载荷形状**：lark-cli 把事件摊平成顶层 snake_case 键（`event_id`/`operator_id`/`chat_id`/`message_id`/`action_tag`/`action_value`），不是 Lark 原始 schema 的 `action.value`——`card-actions.ts` 按这个形状取值，测试 fixture 也照此构造。
- **正文窗口**：最近约 10k 字符，头部折叠提示去 Web（`--web-url`/`LARK_WEB_URL`，Markdown 链接形态；落点是 `<基地址>/system/runs/<runId>`，由 `runPageUrl()` 合成——只给基地址会链到控制台首页，不给就整条链接不渲染）。
- **幂等键**：飞书 `--idempotency-key` 有 **50 字符上限**（99992402），自然键天然超限，统一 `larkIdempotencyKey()` 哈希成 40 位十六进制。
- **重启恢复**：启动读回非终态 `run_card` 行（含 `card_kit_id` 与 `card_seq`）继续驱动；AHP 重连后先收到快照，折进 `turns` 的轮次一到就封版，所以迟到的卡片也能拿到终态。
- **配额警示**：每应用**卡片实体绑定数有配额**（错误 200780，实测约 18 张触发）；高频部署需关注，或为超配额场景保留 IM-patch 降级路径。

## 排队卡片（ADR 0037：一轮 = 一张卡）

一条消息如果落在**正在跑的那一轮**之后，它不会并进当前轮（端侧 POST 消息固定带 `mode: "normal"`，后端在有活跃 run 时一律排队），而是**自己得到一张卡**：卡片头写「排队中」，正文说明「上一轮还在跑，这条消息在排队」，并带一个**取消这条**按钮。

- 取消只取消这条消息（`POST /api/conversations/:id/inputs/:inputId/cancel`），正在跑的那一轮不受影响——就是「取消 steer」的语义。
- **作为追加指示发送**（#64）：把这条排队消息 steer 进正在跑的那一轮（`POST /…/inputs/:inputId/steer {keepIfIdle:true}`）——Claude Tag「话题内回复即折进」的按钮化。`keepIfIdle` 处理竞态：点击时本轮已结束则**保留排队**（下一轮自然消费，绝不弄丢消息），默认直连 steer 路径维持「空闲即取消」旧语义。注入成功后卡片重绘为「已注入本轮」（无按钮、青色头），`input_card` 状态机多一个终态 `steered`——steered 的输入不会再有自己的 run，提升轮询必须停。
- 轮询 `GET /api/conversations/:id/inputs`：该输入被提升成新 run（后端会把 `run_id` 回写到排队行）时，**同一张卡片**接管那一轮（`watchRunCard` 的 `adopt`：复用既有 CardKit 实体与消息 id，首次 flush 整卡替换成运行中的卡），所以一个消息永远只有一张卡。
- 卡片自己的消息 id 与它拿到的话题 id 也登记进 `topic_binding`（用户可能在它排队时回复它）。
- 排队卡片的记录在 `input_card` 表（`queued → promoted | cancelled`），取消回调按「回调的 message_id 必须就是承载该输入卡片的那条、且 chat 一致」校验。

## 内容渲染

投递按 AHP 片段走（`ahp-delivery.ts` 只处理 `markdown` / `systemNotification` / `contentRef`），文本由片段的 `textOf(part)` 取，再过 `normalizeForLarkMarkdown` 做换行与 code fence 收尾；被截断时追加一行 `[消息过长已截断]`。旧的 `renderRevision`（拼 `MessageRevision` 的 text block、`[Unsupported content]` 兜底）已经不存在。工具行到不了渲染：它们在过滤链第 3 步就被跳过。

## surface.control 重绑

backend 只在「开新对话」时写这个 kind，payload 是 `{ type: "lark.start_new_conversation", oldConversationId, newConversationId, reason, requestedByRunId, idempotencyKey }`，同一 idempotencyKey 重复调用返回既有结果（`apps/backend/src/features/conversation/service.ts`）。HTTP 入口是 `POST /api/conversations/:id/start-new`。

watcher 收到续接提示（`systemNotification` 片段，`_meta` 带 `newConversationId` 与 `requestedByRunId`）后调 `rebindConversation`，通过 `onRebind` 关掉旧 watcher、开新 watcher，并发一句「已开启新的对话。」。这条提示是**动作**：`chat-writer.ts` 写完续接记录就 `dispatch(announceContinuity)`，已经连着 watcher 的连接当场收到，不用等重新订阅。

## 进程生命周期与 backend 接线

启动顺序在 `bootstrap.ts`：先抢 PID 锁（同 agent 重复启动直接退出），再取 agent 信息（agent 不存在或被归档、`larkEnabled === false` 时优雅退出；backend 不可达则退出码 1，交给 registry 重启），最后打开 SQLite。`main.ts` 读回全部 chat binding 并为每个会话开 watcher。

心跳每 30 秒一次 `postHeartbeat`，内容是 watcher 计数与 `lastError`。`lark-cli` 退出时，码非 0 且信号不是 SIGTERM 就退出码 1（等 registry 重启），SIGTERM 与 SIGINT 会转发信号、清心跳、释放 PID 锁、关 watcher。

backend 侧：`allowed_senders`、`bot_display_name`、`profile_ref` 落在 agent 配置里，create 与 update 走 `withLarkLifecycle`，启用时先 `profileInit` 再 `ensureLarkBot`，归档与硬删时 `stopBot`。dev 环境 registry 用 `bun <lark-bot bin> --agent-id … --backend-url … --state-root …` 起进程，`BACKEND_AUTH_TOKEN` 只走 env 不走 argv；prod 环境 registry 只 resolve 不 spawn，真实状态由外部进程管理器负责。对外的 lark 状态是 `not_configured | configured | running | degraded | error`，由 `agent/http.ts` 的 `deriveLarkStatus` 从配置与 registry 状态合成（配置没开或没有 profile_ref 就是 `not_configured`）。

## 不变量

1. 飞书端不写账本，也不向后端声明任何身份：memberId 是本地标签。
2. 出站有两个入口：Run 卡片（Run 的 UX 生命周期，含终态）与 AHP watcher（assistant 文本兜底）；对同一条 assistant 行，只有 `fallback_text` 的卡片会让位给文本桥。
3. 卡片是 Run 的 transient 投影：token delta 不持久化到后端，PATCH 失败不影响 Run，终态必须以 canonical 文本封版或降级纯文本送达（ADR 0031/0032）。
4. 文本桥投递意图以非终态标记先落库，发送成功才确认终态；发送失败经重连重放，靠幂等键去重（at-least-once）。
5. 每次文本投递带飞书的 idempotency key，由 `larkIdempotencyKey(...)` 把 `(conversationId, messageId, larkChatId)` 哈希成 **40 位十六进制**（平台上限 50 字符，实测超长报 99992402）——不是冒号拼接，也不含 `seq`。封版降级用 `(conversationId, runId, "seal")` 的哈希；卡片消息本身不带 key（建卡接口不收）。
6. 投递状态只认 `message_delivery`：先记意图后发送，成功才确认终态；重放的同一行被终态判断挡下，所以重订阅安全。
7. 同一个 agent 同时只有一个 lark-bot 进程（PID 锁）。
8. 一个飞书话题 ↔ 一个会话，且一个聊天内可以有多个会话；投递状态按 `(conversation_id, message_id, lark_chat_id)` 记账（ADR 0037）。**群里**的话题内仍然要求 @ 机器人（话题下可能有其他人交流）；**私聊不要求**——私聊本身就是点名，用户「在话题里回复」是续问的唯一动作，再要求 @ 就等于把这条动作废掉。
9. 卡片 JSON 必须过飞书的线级校验，三条踩过的规则：`form` 容器**至少含一个 submit 按钮**（否则 300123，整卡被拒，所以选项按钮不进 form）；`element_id` 只能 ASCII 字母开头、字母数字下划线、**≤20 字符**（300301，所以选项按钮用位置 id `ask_opt_<i>`，不拿选项值拼）；元素内容更新要求目标元素**已存在**（300313，所以 Run 卡的 activity/answer/tools/status 永远渲染，空内容也渲染）。
10. 改渲染器后跑一次 `bun apps/lark-bot/scripts/probe-cards.ts <profile>`：它把真实渲染结果 POST 给建卡接口（不给任何聊天发消息），把只有线上才暴露的拒绝变成几秒的本地检查。会占少量卡片实体配额（应用级，且平台没有删除接口），所以是改渲染器后的动作，不是每次提交的门禁。
11. 卡片连败三次进降级（停止绘制），但**待回答的问题仍重试一次**（按问题 callId 记一次），成功后恢复绘制——降级不能让一个提问变成没人能回答的僵尸。
12. **任何**出站消息（含一次性运维卡）都必须经话题回复发进既有话题，绝不用裸的 `POST /im/v1/messages` 顶层发送：在话题群里顶层消息会**开出一个新话题**，用户在那个新话题里的任何回复都会被当成新任务跑起来（2026-09-25 实测：一张权限申请卡开了新话题，用户回复「授权了」直接触发了一条 run）。回复用 `POST /im/v1/messages/:root_id/reply` + `reply_in_thread`。
13. 带交互元素的卡（追问/批准）不要混排**容器**（`collapsible_panel`）、也不要给按钮加 `width: "fill"`：建卡接口都放行，但真机点击会被客户端拒绝（2026-09-25：同一张卡的停止按钮能点、选项按钮报错）。进度在这种情况下用扁平 markdown，选项对齐靠参考实现的 `column_set`（左列文字 + 右列固定文案按钮，等宽自然对齐）。

14. 会话状态对「等着的 run」不许有盲区（2026-10-14 真机三连测出）：卡只画状态里有的 turn，而一条停在审批上的 run **三路皆空**——账本没有它的消息（没流过内容）、队列没有它的输入（早已投递）、动作流没有它的收尾（writer 对没开过的 turn 一律空返回）⇒ 它从状态里消失，卡连「等待你的确认」都画不出来，结束后终态也画不上（实测建卡后 `seq=1` 定格，取消后仍显示思考中）。因此状态源的 run 集合取「**活跃 + 结束未超过窗口**」（`listRecentRunsForConversations`，窗口 10 分钟），而不是账本与队列的并集。
15. 「这段结束了」不等于「成功」：`chat/turnComplete` **不带状态字段**，归约器一律当 `complete`，所以被停的 run 必须发 `chat/turnCancelled`（`turnActions` 按 run 终态选动作）；同理，卡片侧**没有终态绝不编造**——`?? "completed"` 这类兜底会把行落定，而重启恢复对已落定的卡是**永久空操作**，错状态永远改不回来（2026-10-14：被停的 run 在卡上显示「已完成」且冻结）。排障口诀：卡不动时先问「状态里有没有这条 turn、它带没带结局」，别先猜限流或防抖——本次三层都是这么被否证的。

## 已知缺口

- `surface.control` 的重绑路径没有生产触发入口：`POST /api/conversations/:id/start-new` 目前只有测试调用，旧的触发工具已不存在。路由与端侧消费都已具备。
- `diagnostics.ts` 里的 `runStreams` 字段是 API 兼容空桩，统计恒为 0，对应的表已经从本地 schema 删除。
- 群聊的 @ 检测依赖 `botDisplayName`，缺了就只有单聊可用。
- 出站没有回执：投递成功与否只体现在 lark-cli 的退出码上。
- **reaction 触发做不了，已删**（2026-09-25 实测）：订阅本来就在，但飞书的表情集合里没有可用于「停止」的负向表情——`X`/`THUMBSDOWN`/`CROSS`/`NO` 全部 `231001 reaction type is invalid`，合法值只有 `SMILE`/`THUMBSUP`/`DONE`/`OnIt`/`HEART`/`CLAP`/`OK`/`THANKS`/`FISTBUMP`/`LOL`/`WINK` 这类正向表情。停止一个 run 用卡片按钮或 `/stop`（两条都验过）。教训：依赖平台枚举值的功能，先枚举平台接受值再写代码。
- 多选（`multi`）追问只按单选取值，卡片渲染不出多选控件。自由文本追问走 form（`input` + submit，`form_value` 一次性回传），选择题走整行按钮（`width: fill`），`allowOther` 的选择题也接受话题文字作答。
- 回调只做了单操作者的防重放（event_id 去重 + message↔run_card 映射）。签名 action token 与 backend 侧事件去重留给多操作者场景。
- 工具步骤那行依赖子进程声明活动（`describeStart`）：harness 的 ACP tool_call 只带 `toolName`/`toolCallId`（不带活动文本），对应 Run 就永远只显示工具名；外部 MCP 工具同理，除非它自己声明。
- `native_tool_started.activity` 会随 telemetry 落进 `agent_run_event`（按事件名白名单），也就是活动行进库；目前没有保留期清理。

## 相关页

- [端总览](./overview.md)
- [飞书消息端到端](../flows/e2e-lark-message.md)
- [Conversation History](../conversation/history.md)
- [排障指南](../operations/troubleshooting.md)
