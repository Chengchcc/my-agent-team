# 飞书消息端到端

一句话：本页是飞书端一条消息的权威端到端链路。lark-cli 的事件经幂等占位与绑定解析后 POST 给 conversation API，backend 走与 Web 完全相同的入队、派发、终态提交路径，sse-watcher 再从该会话的 conversation SSE 上把终态 assistant 行渲染成纯文本发回飞书。

## 范围

覆盖：从 `lark-cli event consume` 的一行 stdout 到飞书收到回复之间每一次 HTTP 与 SSE 交互、每张本地表的变化、去重键的选择，以及出问题先看哪一层。

不覆盖：Web 端（见 [Web 消息端到端](./e2e-web-message.md)）、飞书端内部四张表的字段级细节（见 [飞书](../surfaces/lark.md)）、backend 执行层的通用语义（见 [Run 输出与实时更新](../runs/output-and-live-updates.md)）。

## 实现文件

- `apps/lark-bot/src/main.ts` — 事件消费循环、watcher 表与 ingest 调用
- `apps/lark-bot/src/ingest.ts` — 整条入站路径
- `apps/lark-bot/src/sse-watcher.ts` — 整条出站路径
- `apps/lark-bot/src/bindings-sqlite.ts` — 本地四表与推送游标
- `apps/backend/src/features/conversation/{http.ts,service.ts}` — 消息写入与触发
- `apps/backend/src/features/agent-run/{adapter-sqlite-enqueue.ts,execution-dispatch.ts,adapter-sqlite-runs.ts}` — 入队、派发、终态提交
- `apps/backend/src/bootstrap/features.ts` — 提交后的即时推送与失败气泡

## 端到端步骤

1. **收到事件**（`apps/lark-bot/src/main.ts`）：`lark-cli --profile <p> event consume im.message.receive_v1 --as bot` 的 stdout 按行读出，`parseEvent` 解析成带 `event_id`、`message_id`、`chat_id`、`chat_type`、`sender_id`、`content` 的结构化事件，解析失败的行只打日志。
2. **鉴权**（`apps/lark-bot/src/ingest.ts`）：`sender_type` 存在且不是 `"user"` 直接跳过；再按 agent 配置的 `allowedSenders` 白名单过滤，空数组表示放行所有人。
3. **幂等占位**：同一个 sqlite 事务里先 `inboundExists`（按 `event_id` 或 `message_id`）判断是否已处理，再 `reserveInbound` 落一行 `status = "processing"`。占位在 POST 之前，选择的是「宁可丢一条入站也不重复触发 run」。
4. **解析或建立绑定**：`chat_binding` 命中就直接用它的 conversationId；没有则 `POST /api/conversations {agentId}` 新建，再只写本地的 `chat_binding` 与 `member_binding`。后端没有成员表，`human:lark:<open_id>` 只是这个端自己的标签。
5. **定路由**：单聊不传 `senderMemberId` 与 `addressedTo`，由服务端派生成 sender 是用户、target 是会话 agent；群聊传 `senderMemberId`，`addressedTo` 在机器人被 @ 时为 `[selfAgentId]`，否则为 `[]`（即不触发）。
6. **POST 消息**：`content` 为 `{ text, source: "lark", larkEventId, larkMessageId }`，打到 `POST /api/conversations/:id/messages`，返回 202 与 `{ seq, triggeredRuns }`。
7. **写人类行**（`apps/backend/src/features/conversation/service.ts` 的 `postMessage`）：先写一条 `role: "user"`、`state: "done"` 的账本行，再判断触发。触发条件是目标列表包含本会话的 agent。
8. **入队并派发**：飞书没有专属执行分支，走的是与 Web 相同的 `#triggerForAgent` → `enqueueAndAcquire` 单事务 → `#dispatchRun`。分支上已有 active run 时，这条输入进 `branch_input_queue` 排队，等它终态后由 `acquireNextRun` 提升为新 run。
9. **子进程期间**：adapter 为这个 run spawn 一个 oma 子进程，子进程事件经 `mapRunEvent` 变成 `text_delta`、`thinking_delta`、`status` 等 transient 事件，只广播给当前进程的订阅者，**不落账本**。飞书看不到任何中间态，这个期间它什么也不发。
10. **确认入站**：POST 成功后 `confirmInbound` 回填 `conversationId` 与 `ledgerSeq`，`status` 转为 `posted`。POST 之后崩掉的话事件不会重放，但账本里那条人类消息已经生效。
11. **终态提交**（`execution-dispatch.ts` 的 `settleOutcome` → `commitCompletedRun`）：outcome 为 `completed` 时，一个事务里把 canonical 消息逐条写进账本，assistant 的 messageId 是 `run:<runId>:assistant:<n>`，工具行形如 `run:<runId>:tool:<index>`，`state` 统一 `done`；非 `completed` 的终态不写 assistant 行，另由 `onRunFailed` 落一条 `run:<runId>:error` 的失败气泡。
12. **回推到 watcher**：`onRunCommitted` 对每个提交的 seq 调 `notifySeq`，在线的 conversation SSE 订阅者立刻收到这些帧；漏掉的靠 `subscribeConversation` 的 5 秒轮询兜底。
13. **出站过滤**（`apps/lark-bot/src/sse-watcher.ts` 的 `processEntry`）：按 seq、`surface.control`、非 message 帧、`role` 为 `system` 或 `user` 依次过滤；`tool` 行不在排除名单里。
14. **去重**：以 `(conversationId, messageId, larkChatId)` 查 `message_delivery`，命中且上一状态是终态就跳过。未命中则先 `upsertMessageDelivery` 记投递意图，再发送，最后推进 `pushedSeq`。
15. **投递**：`renderRevision` 取出文本并过 `normalizeForLarkMarkdown`（换行、code fence 收尾、超长截断），再经 `lark-cli im +messages-send --idempotency-key <conversationId:messageId:seq>` 发出。失败退避重试 3 次，耗尽后只记日志并抛错，`pushedSeq` 因此停在原地。
16. **表面恢复**：进程重启后按 `chat_binding` 为每个会话重开 watcher，从各自的 `pushedSeq` 继续。重放的帧被 `message_delivery` 的终态判断挡掉，所以不会重复发送。

## 重绑（surface.control）

backend 的 `startNewConversationForSurface` 在新会话建好后往旧会话账本写一条 `lark.start_new_conversation`，带 `oldConversationId`、`newConversationId`、`requestedByRunId`，同一 `idempotencyKey` 重复调用返回既有结果。watcher 收到这类帧后调 `rebindChatConversation`，重置新会话的 `pushedSeq`，通过 `onRebind` 关掉旧 watcher、开新 watcher，并发一句「已开启新的对话。」。

HTTP 入口是 `POST /api/conversations/:id/start-new`，目前只有测试调用，没有生产触发方。

## 出问题先看哪层

| 症状 | 先看 | 接着读 |
|---|---|---|
| 飞书没收到任何回复 | `message_delivery` 是否已记投递意图、`chat_binding.pushed_seq` 是否在推进 | [飞书](../surfaces/lark.md) |
| 机器人没反应 | `allowed_senders` 是否包含该用户、群聊是否 @ 到机器人（`botDisplayName` 存在吗） | [飞书](../surfaces/lark.md) |
| 回复重复 | 重连重放时 `message_delivery` 是否命中，或 `lark-cli` 的 idempotency key 冲突 | [飞书](../surfaces/lark.md) |
| 账本里有行但飞书没发 | 该行的 `role` 是否被过滤、`renderRevision` 是否只拿到非文本块 | [Run 输出与实时更新](../runs/output-and-live-updates.md) |
| 回复发到了错误的会话 | `chat_binding` 指向的 conversationId 与 `surface.control` 重绑结果 | [飞书](../surfaces/lark.md) |

## 不变量

1. 入站幂等键是飞书事件与消息 id；出站去重键是 `(conversationId, messageId, larkChatId)`。
2. 投递意图先落库再发送，发送失败不重发。
3. `pushedSeq` 只在投递路径走完之后推进。
4. 飞书端不写账本，也不向后端声明身份。
5. 「飞书 chat 到 conversation」的映射只存在于本地 `chat_binding`，后端不感知。

## 相关页

- [飞书](../surfaces/lark.md)
- [Web 消息端到端](./e2e-web-message.md)
- [Conversation History](../conversation/history.md)
- [Agent 工作区与后端](../agents/workspace-and-backends.md)
- [排障指南](../operations/troubleshooting.md)
