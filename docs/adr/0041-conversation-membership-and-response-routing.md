# ADR 0041: 会话成员模型与响应路由（1:1 自动响应，多成员 @提及响应）

## 状态

Proposed（2026-10-03）。部分取代 [ADR 0021](./0021-one-conversation-one-agent-member.md) 的决策 1/3/5；0021 的投影边界约束（session 与 conversation 互不重建）**原样保留**。

## 上下文

0021（2026-08-13）删除了早期多成员机制（member roster、@mention 定向、wake routing、relationships），把 conversation 收敛为单 agent 的产品态投影。删除时的理由成立：那套机制无 UI 入口、无真实使用、relationships 是死代码。

但收敛把两件事一起扔了：**响应路由的语义**（1:1 时不用 @ 也响应、多 agent 时只 @ 才响应——这条语义在删除前的设计与 postMessage 残留的 `addressedTo` 判断里都在）和**会话作为共享时间线**的价值。产品要长成 AI-native IM（对照 docs.raft.build），会话必须是"房间"而不是"单 agent 的私有投影"：用户在同一个对话里点名不同的 agent，agent 之间通过共享时间线互相看见。

与被删除的旧机制不同，本决策**不恢复** wake routing、relationships、thing 实体——那是 0021 已判死的部分，保持死亡。

## 决策

1. **会话成员 1..N 个 agent，语义由成员数派生，不存模式字段**：
   - **1 个成员（1:1 / e2e）**：未被 @ 的消息自动触发该 agent——与今天的行为字节兼容；
   - **2+ 个成员（房间）**：只有被 @提及 的消息触发对应 agent；未被 @ 的消息只进账本（共享时间线），不触发任何 run。
   - **非人类输入源带目标**：reminder 到点投递、workflow agent 节点派发等系统输入**必须携带 addressedTo**（reminder = 其作者；workflow = 节点声明的 agent），否则在房间里永不触发——这是入队路径的硬约束，不是可选项。
2. **入口与生长**：点 agent 开 1:1 会话（现状）；会话可拉入新 agent（Web 成员管理 + Lark 绑定带入）；拉入第二个成员的瞬间，语义从自动切为 @提及（无需迁移，派生即切换）。
3. **上下文线按 agent 隔离**：每个成员 agent 在会话下有自己的 context tree（`agent_context_tree` 加 `agent_id`，唯一索引从 `(conversation_id)` 改 `(conversation_id, agent_id)`）。tree 不共享、branch 不共享——0021 的隔离纪律在房间内保持；**账本是会话级共享事实**，各成员的 `ledgerCursor` 独立推进。
4. **追赶靠 cursor，检索靠工具，不做投递**：成员被触发时，入队事务把**其 ledgerCursor 之后的全部账本行**（含此前未被 @ 的房间闲聊）拷进该成员的上下文——房间里的Agent互见靠这个既有机制，不是新造的。history_recent / history_search / history_around 只是**更深**的按需检索补充（cursor 之前的、跨会话的）。显式不做：把消息主动投递进未触发成员的投影。
5. **并发 run 允许**：同一会话不同成员的枝可并行跑（workspace lock 按枝串行，互不阻塞）；账本按 seq 交错，时间线按 seq 渲染。前置验证：Web 画布与 Lark 卡对同会话多活 run 的承载（`triggeredRuns` 在 wire 上已是数组）。
6. **Lark 直映射**：Lark 群 ↔ 会话。事实约束：lark-bot 是**单个** Lark 应用，群里只有一个 bot 身份——多 agent 靠**消息文本里的 @名字解析**到成员表（不是多 bot）。绑定配置声明该群映射的 agent 成员（默认 1 个，可配多个）；@名字命中成员 → `addressedTo` 该成员。
7. **0021 的投影边界约束保留**：禁止从 session 重建 conversation；`cliSessionRef` 仍为不透明引用。本决策只放宽"一个投影一条 agent 线"为"一个投影一**组** agent 线（各线隔离）"。

## 边界与空白（显式记录，落地时补决策）

- **房间的 fork**：fork 会话时携带全部成员的树，还是只带默认 agent 的树？——倾向全部（fork 是完整时间线分叉），落地迁移时定。
- **无目标消息的 mode**：房间 + 未被 @ 的消息只落账本，**永不入队**——steer / follow_up 模式对它无意义，入队层直接短路。
- **workflow 起源会话**（origin=workflow，聊天面不可见）：豁免成员模型，维持单 agent 语义。

## 后果

- **Schema/迁移**：`agent_context_tree` 加 `agent_id` + 索引改形（存量树回填 `conversation.agentId`）；成员承载用 `conversation` 新表 `conversation_member`（conversation_id, agent_id, added_at, 唯一键），`conversation.agentId` 保留为**默认路由与 1:1 语义的来源**（兼容层，成员表为真相）。
- **路由**：`postMessage` 的 trigger 判断从"单 agentId 判等"升级为"成员遍历 + 派生语义"；`addressedTo` 从只判等变为真正的路由输入。
- **派发**：run 归属 (conversation, agent)；输入队列与 active-run 检查按成员枝进行。
- **Web**：会话详情成员管理（拉人/移出）；多活 run 的时间线渲染验证。
- **Lark**：群消息 @提及 解析 → addressedTo；绑定时多 bot 带入。
- **回退**：成员表清到单成员即回到 0021 行为，无需数据回滚。

## 删除清单（验收条件）

| 项 | 何时 |
|---|---|
| `postMessage` 里 "1:1 单 agentId 判等" 的 trigger 分支 | 成员遍历路由上线时 |
| `conversation.agentId` 作为路由真相（降级为派生默认值） | 成员表成为唯一真相、全链路读成员表时 |
| Lark 绑定单 agent 假设（一群一 agent） | Lark 多 bot 带入落地时 |
| `agent_context_tree` 的 conversation 唯一索引 | 迁移 00XX 落地时 |

## 不做（显式）

- wake routing / relationships / thing 实体（0021 已判死，维持）
- 广播投递（全员收消息进各自投影）——拉取模型已覆盖响应所需
- 跨会话任务聚合（raft #3 任务卡独立推进）
