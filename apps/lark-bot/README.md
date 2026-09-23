# @chengchenccc/lark-bot

把飞书(Lark)当作一个对话 surface 的桥接常驻进程。它让用户能像和普通联系人聊天那样跟 agent 对话：一端连飞书的 IM 事件流，一端连 backend 的会话 API，在两边之间双向翻译。一个 agent 对应一个 lark-bot 进程，由 backend 拉起和管理。

## 它负责什么

lark-bot 不跑模型，也不持有会话状态——它只做转译和投递。核心是两条方向相反的链路：

**入站(飞书 → backend)。** 进程通过 `spawn` 启动 `lark-cli ... event consume im.message.receive_v1`，从它的 stdout 按行读 NDJSON 事件。`event-parser.ts` 把每行解析成带 `event_id`/`message_id`/`chat_id`/`chat_type`/`sender_id`/`content` 的结构化事件，非法行丢弃。随后 `ingest.ts` 走 reserve→POST→confirm 流程：先在本地 SQLite 做幂等占位(同一 `event_id`/`message_id` 不重复处理)，没有对应会话则 `POST /api/conversations` 新建并加入人类成员，再 `POST /api/conversations/:id/messages` 投递消息，最后回填 ledger seq 确认。p2p 默认定向到本 agent；群聊里需要 `isBotMentioned` 检出 `@<botDisplayName>` 才定向(缺 botDisplayName 时按 fail-closed 不定向)。

**出站(backend → 飞书)。** 每个已绑定会话对应一个 `sse-watcher.ts` 监听器，订阅 `/api/conversations/:id/events`，从 `pushedSeq` 之后接收 ledger 条目。它会过滤已推送条目、非 message 类型、系统消息、tool 行、以及本 chat 人类成员的回声；assistant 行的 messageId 若形如 `run:<runId>:assistant:<n>` 且该 Run 有卡片(状态非 `fallback_text`)，则跳过文本发送——卡片拥有这条 Run 的投递权(ADR 0031 决策 8)。`surface.control` 里的 `lark.start_new_conversation` 触发会话重绑(`onRebind`)。

**Run 卡片(ADR 0031)。** ingest 拿到 `triggeredRuns` 后，`run-card/` 为每个 run 发一张流式卡片：占位 → 消费 `/api/agent-runs/:runId/events`(text_delta 追加正文、工具只记摘要、approval/ask 切「等待」态) → 150ms/120 字符节流 PATCH(单飞 flush 控制器) → 终态以 `terminalResult.messages` 的 canonical 文本封版，封版失败降级发纯文本并把卡标 `fallback_text`(交还文本桥)。`/stop` 入站命令取消该 chat 的全部活跃 run。卡片投递状态在本地 `run_card` 表，重启后恢复驱动。

## 数据流与状态存储

一次完整往返：飞书消息 → lark-cli stdout → parse → ingest 转发 backend → backend 触发 run → run-card 流式卡片 + sse-watcher 终态兜底 → 飞书。

所有绑定关系都存在本地 SQLite(`bindings-sqlite.ts`，每个 agent 一个 `bindings.sqlite`)：`chat_binding` 记录飞书 chatId↔backend conversationId 及 `pushed_seq`；`member_binding` 记录飞书发送者↔会话成员；`inbound_message` 做入站幂等。

## 启动与生命周期

`bootstrap.ts` 启动时：抢 PID 文件锁(避免同 agent 重复实例)、向 backend 拉取 agent 信息(已归档/未启用 Lark 则优雅退出)、打开 SQLite、为已有绑定恢复 SSE 监听器。`main.ts` 随后起 30s 心跳上报 surface 健康、spawn lark-cli 消费事件。收到 SIGTERM/SIGINT 时转发给 lark-cli 子进程、关闭所有监听器、释放 PID 锁。

## 怎么跑起来

package.json 脚本：`build`(tsc)、`typecheck`、`test`(bun test)、`lint`。进程一般由 backend 的 registry 拉起，直跑示例：

```bash
bun run src/main.ts \
  --agent-id=agent-42 \
  --backend-url=http://localhost:3000 \
  --state-root=./.data \
  --bot-display-name="Mira" \
  --agent-name="Mira" \
  --lark-profile=agent:agent-42 \
  --backend-auth-token=dev
```

参数解析见 `src/args.ts`：`--agent-id` 必填；`--backend-url`(默认 `http://localhost:3000`，可由 `BACKEND_URL` 兜底)、`--state-root`(默认 `./.data`，可由 `BACKEND_DATA_DIR` 兜底)、`--bot-display-name`、`--agent-name`、`--lark-profile`(缺省回退为 `agent:<safeAgentId>`)、`--backend-auth-token`(可由 `BACKEND_AUTH_TOKEN` 兜底)、`--web-url`(卡片页脚「在 Web 查看」链接，可由 `LARK_WEB_URL` 兜底，缺省不渲染链接)。

## 已知残留

`diagnostics.ts` 里的 `watchers.runDelta` 与 `runStreams` 是恒为 0 的兼容空桩；卡片交互只有 `/stop` 命令与 Web 深链，reaction 触发与卡片按钮回调通道未实现(ADR 0031 决策 6)。

## 依赖

依赖四个工作区包：`@chengchenccc/api-contract`、`@chengchenccc/backend`、`@chengchenccc/config`、`@chengchenccc/message`。前两个是跨进程类型来源——lark-bot 用 backend 的 Eden `App` 类型调 REST，用 api-contract 的 schema 校验 SSE 帧，两端各写一份 schema 是不行的。其余只靠 `bun:sqlite`、外部 `lark-cli` 二进制和 Node 标准库；进程由 backend 的 LarkBotRegistry 管理。
