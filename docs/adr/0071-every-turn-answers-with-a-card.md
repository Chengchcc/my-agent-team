# ADR 0071: 任何来源的 turn，在这间房里都用卡片回

- 状态: Accepted
- 日期: 2026-11-19
- 相关: ADR 0031（卡片）、ADR 0066（会议室/展厅）、ADR 0070（派发即子会话）

## 背景

运营者发现：**从 API 下发的活，前台在 Lark 里回的是纯文本，不是卡片。**

排查结论（不是偶发）：

- 卡片的创建只发生在**Lark 消息触发的 run** 那条路径上（`ingest → startRunCard`）；
- 从 API / Web / workflow 触发的 run **没有 Lark 源消息**，因此没有卡片；
- 机器人只走了 AHP watcher 的**纯文本投递**。

真机证据：API 触发的几个 run（`caeab2d2`、`9a9e4ff9`、`6577b985`、`11370dd5`、`c8cdd4f9`）在 `run_card` 表里**一行都没有**。

## 决策

**一间被监听的房里出现的 `activeTurn`，如果没有卡片就补一张。**

- 位置：`onChatState`（AHP 状态每次到达时检查）；
- 条件：`chat.activeTurn` 存在、`cardWatchers` 里没有、`run_card` 表里没有；
- 卡片以 `replyTo: null`（DM 平铺 / 群话题逻辑仍由既有 `replyInThread` 决定）。

**只对运行中的 turn**：已完成的历史 turn 不补卡——启动时按 `chat.turns` 扫一遍会给旧对话贴一排迟到卡片（真机上发生过：一次启动补了 3 张），那是噪声，不是回答。

代价：一个**极快**的 run 可能在第一帧状态到达前就结束，于是仍然只有纯文本。这比"给历史补卡"安全，也与现状一致。

## 不变量

1. 房间里你正在等的那一轮，答案以卡片呈现——**不管这一轮是谁触发的**（Lark、API、Web、workflow）。
2. 卡片永不"迟到补发"给已完成的 turn。
3. 卡片与文本不重复投递：有卡片时 watcher 只更新卡片，不另发文本。

## 落点

| 层 | 文件 |
|---|---|
| 触发 | `apps/lark-bot/src/main.ts`（`onChatState`：`activeTurn` → `startRunCard`） |

## 验收

1. ✓ API 触发的 run 现在建卡并流式更新（真机：`2eb41e72` 卡片 `completed`，`card_send_failed=0`、`card_update_failed=0`）。
2. ✓ 机器人重启不为历史 turn 补卡（真机：重启后日志里 0 条 `came from another surface`）。
3. 残留风险（如实记录）：首帧前就结束的 run 仍回退纯文本。
