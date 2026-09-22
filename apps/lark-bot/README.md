# @chengchenccc/lark-bot

把飞书(Lark)当作一个对话 surface 的桥接常驻进程。它让用户能像和普通联系人聊天那样跟 agent 对话：一端连飞书的 IM 事件流，一端连 backend 的会话 API，在两边之间双向翻译。一个 agent 对应一个 lark-bot 进程，由 backend 拉起和管理。

## 它负责什么

lark-bot 不跑模型，也不持有会话状态——它只做转译和投递。核心是两条方向相反的链路：

**入站(飞书 → backend)。** 进程通过 `spawn` 启动 `lark-cli ... event consume im.message.receive_v1`，从它的 stdout 按行读 NDJSON 事件。`event-parser.ts` 把每行解析成带 `event_id`/`message_id`/`chat_id`/`chat_type`/`sender_id`/`content` 的结构化事件，非法行丢弃。随后 `ingest.ts` 走 reserve→POST→confirm 流程：先在本地 SQLite 做幂等占位(同一 `event_id`/`message_id` 不重复处理)，没有对应会话则 `POST /api/conversations` 新建并加入人类成员，再 `POST /api/conversations/:id/messages` 投递消息，最后回填 ledger seq 确认。p2p 默认定向到本 agent；群聊里需要 `isBotMentioned` 检出 `@<botDisplayName>` 才定向(缺 botDisplayName 时按 fail-closed 不定向)。

**出站(backend → 飞书)。** 每个已绑定会话对应一个 `sse-watcher.ts` 监听器，订阅 `/api/conversations/:id/events`，从 `pushedSeq` 之后接收 ledger 条目。它会过滤已推送条目、非 message 类型、系统消息、以及本 chat 人类成员的回声；`surface.control` 里的 `lark.start_new_conversation` 触发会话重绑(`onRebind`)。需要推送的 agent 回复经 `render.ts` 抽取成纯文本后投递，并推进 `pushedSeq`(投递失败时抛错以阻止 seq 前进，保证不丢消息)。

> 当前 = 文本桥：流式卡片能力已移除于 M17(`run-delta-watcher`/`card-renderer`/`card-sender` 均不存在)，回复统一走纯文本。

## 数据流与状态存储

一次完整往返：飞书消息 → lark-cli stdout → parse → ingest 转发 backend → backend 触发 run → sse-watcher 推 ledger 文本 → 飞书。

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

参数解析见 `src/args.ts`：`--agent-id` 必填；`--backend-url`(默认 `http://localhost:3000`，可由 `BACKEND_URL` 兜底)、`--state-root`(默认 `./.data`，可由 `BACKEND_DATA_DIR` 兜底)、`--bot-display-name`、`--agent-name`、`--lark-profile`(缺省回退为 `agent:<safeAgentId>`)、`--backend-auth-token`(可由 `BACKEND_AUTH_TOKEN` 兜底)。

## 已知残留

卡片时代留下的东西没有全部清干净。`diagnostics.ts` 里 `watchers.runDelta` 与 `runStreams` 的 `cardSendFailed`/`cardUpdateFailed` 是恒为 0 的兼容字段；`markdown-normalizer.ts` 当初是给卡片写的（HTML 转义、图片转链接都只对卡片有意义），现在只剩纯文本路径 `render.ts` 在调它，卡片专属那部分属于死重量。另外 `role: "tool"` 的账本行不在出站排除名单里，会被当纯文本发出去。

## 依赖

依赖四个工作区包：`@chengchenccc/api-contract`、`@chengchenccc/backend`、`@chengchenccc/config`、`@chengchenccc/message`。前两个是跨进程类型来源——lark-bot 用 backend 的 Eden `App` 类型调 REST，用 api-contract 的 schema 校验 SSE 帧，两端各写一份 schema 是不行的。其余只靠 `bun:sqlite`、外部 `lark-cli` 二进制和 Node 标准库；进程由 backend 的 LarkBotRegistry 管理。
