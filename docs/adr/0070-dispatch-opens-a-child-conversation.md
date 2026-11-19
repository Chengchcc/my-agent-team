# ADR 0070: 派发即开一间子会话 —— 会话树

- 状态: Accepted（S1 落地：数据、派发路径、房间入口；设置的 UI 开关待补）
- 日期: 2026-11-19
- 相关: ADR 0049（前台不变量）、ADR 0051（`parentRunId`）、ADR 0059（双工回填）、ADR 0066（会议室/展厅）

## 背景

派发最初是"**在同一个会话里**给另一个 agent 起一个 run"（`parent_run_id`）。于是：

- 工人的过程与前台、人的对话**共用一个账本**，只靠 `_meta.authorAgentId` 在**渲染时**过滤掉；
- 房间里能点进去的只有 `/system/runs/<id>`——运营者的原话：*"run 我看什么呢？"*；
- 派单摘要那条是 `role: user` 的输入，页面上曾经渲染成"人自己发的"。

运营者给出的模型（2026-11-19）：

> worker 执行的过程，我不期望是跳到一个 run，而是 worker 自己独立的 conversation，可以在会议室里跳过去，本身也作为一个独立的 conversation，收敛到和前台的这个会话下。派发时可以支持 worker 保持同一个 parent 下同一个子 conversation，还是本次单独一个。

## 决策

### D1 派发 = 开一间子会话

`conversation.parent_conversation_id`（可空，自引用）。派发时在**父会话下**创建一间 `origin: "dispatch"`、`agent_id` = 工人的会话，派单说明作为第一轮输入落在**那间房里**，run 在那间房里跑。

父房间只留一条**摘要**：`→ 已派给 <工人>：「<任务首行>」`，由**前台署名**（`senderMemberId` = 前台）、`addressedTo: []`（不触发 run），并带 `dispatchTo: { conversationId }` 指向子会话。

### D2 默认复用，按对 (父, 工人) 复用

`dispatch.reuseChildConversation`（settings，默认 `true`）：**同一对（父会话, 工人）默认复用同一间子会话**，上下文连续；设成 `false` 则每次派发新开一间。不同工人永不共享房间。

### D3 子会话不进侧边栏，但从房间可达

会话列表只取 `origin ∈ {user, fork}`——子会话（`origin: "dispatch"`）因此**不占侧边栏**。它的入口是房间摘要上的 **打开子会话 ↗** 链接（`/chat/<id>`）。

### D4 工人结论回到父房间

沿用 ADR 0059 的回填：工人 `report` / 终态通知唤醒前台，前台在**父房间**里说一句结论。运营者要求"要留"，所以父房间的可见内容 = 派单摘要 + 结论，过程留在子会话。

### D5 父房删除带走子房

SQLite 只能给已有表 `ADD COLUMN ... REFERENCES`，**不能带 `ON DELETE cascade`**（drizzle 快照记了 cascade，生成的 SQL 里没有）。因此删除路径**显式先递归删子房**，再删自己。

### D6 历史不迁移

旧的 run 式派发记录**直接删除**（运营者拍板），不做数据迁移：新模型只对新的派发生效。

## 不变量

1. 一个 run 永远在**一间**会话里跑；派发的 run 在子会话里，不在父会话里。
2. 父房间只出现：人的话、前台的发言（含派单摘要与结论）。工人的过程在子会话。
3. 摘要由前台署名，且**不触发**任何 run。
4. 删除父房间 = 删除它的全部子房间。
5. 复用只在同一 (父, 工人) 上发生；`reuse: false` 一定新建。

## 落点

| 层 | 文件 |
|---|---|
| 数据 | `infra/db/schema.ts`（`parent_conversation_id`）、`drizzle/backend/0063_*` |
| 端口/适配器 | `features/conversation/{ports,adapter-sqlite}.ts`（创建、`listChildConversations`、级联删除） |
| 服务 | `features/conversation/service.ts`（`createChildConversation` / `dispatchRoom`） |
| 派发 | `bootstrap/features.ts`（派单进子房 + 父房摘要）、`conversation/service.ts`（`dispatchTo` 落账） |
| 投影 | `features/ahp/state-source.ts`（`_meta.dispatchTo`） |
| 房间 | `apps/web/src/lib/chat-state.ts`、`components/Timeline.tsx`（**打开子会话 ↗**） |
| 单房路由 | `features/conversation/http.ts`（返回 `parentConversationId`） |

## 验收

1. ✓ 子房记录 `parent_conversation_id` 与 `agent_id`，`origin: "dispatch"`（不进侧边栏）。
2. ✓ 默认复用：同一 (父, 工人) 两次派发同一间；`reuse: false` 新建；不同工人不复用（变异：去掉 reuse 分支 → 红）。
3. ✓ 房间摘要携带 `dispatchTo.conversationId`；畸形载荷不渲染链接。
4. 待真机：一次派发后，父房出现摘要、点进去落在子会话、子房里有工人的完整过程。
