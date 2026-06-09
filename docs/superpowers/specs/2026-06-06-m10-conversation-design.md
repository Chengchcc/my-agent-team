# M10 Design Decisions — 实现级补充

> 基于 M9 真实代码 `bafec1e` 的 grilling 结论，经 self-critique 纠正。与 [14-conversation](./14-conversation.md)（持久架构）和 M10 spec（本期切片）自洽。

## 关键 M9 事实前提

- `AgentEvent` = `message | interrupted | error`，无 `addressedTo` 字段
- `event_log` 在 `events.db`，子进程直写；backend 只通过 `EventLog.subscribe({runId})` 读取
- `onRunComplete(threadId, runId)` 不含 output——output 在 event_log 里
- `CheckpointReadPort` 只有 `getMessages()`，无写口
- `threads: Set<string>` 锁粒度是 threadId
- `threadId` 是不透明 `ulid()`，无内部结构
- **前置债**: M9 子进程 checkpointer 写 workspace file db（`cpDir/db.sqlite`），backend read adapter 读 `backend.db`——两者不是同一个库。广播投影需统一写库，见 D15。

---

## 决策记录

### D14: @mention 来源 — surface 显式传 `addressedTo`

`addressedTo` 由调用方（surface/CLI）在 POST body 里显式传字符串数组。spec §4.1 已有 `resolveTriggerTargets(conv, addressedTo)` 纯函数做校验。**不做** backend NLP 解析 agent 自由文本中的 `@`——runner/AgentEvent 零改动。

### D15: 广播投影写路径 — 前置债：checkpointer 库归一

spec D7 决定广播投影经 checkpointer 物化进 thread.messages。但 M9 子进程 checkpointer 写 workspace file db ≠ backend read adapter 读 backend.db。**M10 必须在 fork 前把 checkpointer 指向统一库**（注入 `checkpointerDb` 或在 `spec.storage.checkpointer` 传 backend.db path），否则投影写进去子进程读不到。这条已补入 `2026-06-06-m10-member-conversation.md` §5 前置债。

### D16: threadId 派生 — `${conversationId}:${memberId}`

确定式、免存映射、冒号分隔。spec §4.2 已定。旧 ULID thread 退化兼容：`conversationId = threadId`。

### D17: agent thread 创建时机 — lazy at first fork

`ensureThread()` 在首次 fork 该 agent member 时幂等创建 thread row + checkpoint 空行。M10 `mention` 模式下，未被 @ 的 agent 不起 run；下次被 @ fork 时投影补齐 ledger 历史即可。不在 member join 时预建（避免空 thread），不在首次投影时预建（超前优化）。

### D18: 单活跃 run 锁 — ConversationService 层

ConversationService 维护 `activeConversations: Set<conversationId>`，409 在此层抛。RunService 的 threadId 锁原样保留（守单 thread 串行性）。两锁语义不冲突。

### D19: agent 输出回写 ledger — run 结束时一条 append

Run 结束 → `onRunComplete` 触发 → 从 event_log 读该 run 终态 assistant message → **一条** `kind:"message"` ledger append（sender=agentMember）+ 投影 + hop 判定。**不做**流式管线逐 event 回灌——ledger 粒度 = 一条会话消息（wiki §五），event_log 粒度 = 一个执行事件，分层不混淆。

### D20: Migration ID 段 — backend.db 三表 4000/4001/4002

| 表 | ID | DB |
|---|---|---|
| `conversation` | 4000 | backend.db |
| `member` | 4001 | backend.db |
| `conversation_ledger` | 4002 | backend.db |

三表同库，支持 `conversation_ledger REFERENCES conversation(conversation_id)` 外键。spec §4.4 已定。

### D21: ConversationService — 独立 feature

`features/conversation/`（service.ts + http.ts + ports.ts + adapter-sqlite.ts + index.ts），依赖注入 RunService、EventLog、CheckpointPort、ThreadService。spec §4.1/§4.4 已定。

### D22: SSE 会话级投影 — ts 归并 + 合成 cursor

ledger（backend.db）与 event_log（events.db）各自独立 AUTOINCREMENT，无法共用统一 seq。会话级 SSE 按 `ts` merge-sort，用合成 cursor（`${source}:${rawSeq}`）做 `Last-Event-ID` 断点续传。wiki §五 line 137 已修正措辞。

### D23: hop_count — 持久化，重启保持锁定

`conversation.hop_count` 落库。重启后超限会话保持暂停态，真人/外部新消息进来才重置。spec D13 + DDL 已定。

### D24: legacy alias — 转发到 POST /conversations/:cid/messages

`POST /threads/:id/runs` 查该 thread 的唯一 agent member → 转发 `POST /conversations/:cid/messages`。多 member 返回 400。spec §5.1 已定。
