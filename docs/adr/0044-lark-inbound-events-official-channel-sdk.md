# ADR 0044: Lark 入站事件层换成官方 channel SDK（丙）

> 来源：路线图「飞书云文档评论这个面没有」一条。2026-10-14 在隔离 app（`spike-doc` = `cli_aa4459351974dd2c`）上把两个前提都实测通过，从「不确定能不能做」变成「已知怎么做」。

## 状态

Proposed（2026-10-14）。两个前提已实测：**云文档评论事件确实经长连接到达** ✓（收到的事件载荷含 `event_type: drive.notice.comment_add_v1` / `comment_id` / `reply_id` / `is_mentioned:false` / `notice_meta.from_user_type:"user"` / `is_from_agent:false`），**卡片回调的载荷形状够用** ✓（`messageId` / `chatId` / `operator.openId` / `action.tag` 直接对应，去重键在 `raw.event_id`）。**决策 1 至 6 与 8、9 已实现**（传输层 + 评论面，`apps/lark-bot` 240 个测试、lint/typecheck 全绿；生产 bot 已真机重启并连上官方 SDK，`lark-cli` 总线与两个消费者已消失）。**决策 7 实现了后端那一半**：`larkSetupGuidance` 给出三类事件名、scope 清单与 `scope-apply` 链接，并已进入 Lark surface 视图；Web 面板的渲染待做。**决策 10（隔离 app 上的端到端验收）待做**——需要生产 app 补齐事件订阅与 scope 后才能跑评论那条。

## 上下文

**今天的入站是 lark-cli 的总线。**`apps/lark-bot/src/main.ts` 起两个子进程：`lark-cli event consume im.message.receive_v1` 与 `… card.action.trigger`。两者都是**一行 NDJSON** 进 `parseEvent()` / `parseCardActionLine()`，再由 `ingest()` 走 reserve→POST→confirm，卡片回调由 `handleCardActionLine()` 校验本地 `run_card` 行后调后端。

**这条通道收不到云文档评论事件。** 总线的可订阅目录实测是 25 个键、9 个域（无 `drive`），`event consume drive.notice.comment_add_v1` 当场拒收；上游 `events/all.go` 只聚合 7 个域，注释写明「Mail is intentionally omitted in this phase」——**整域按阶段略过**是上游自己写的工作方式。

**官方 `@larksuite/channel` 提供这一层。**它依赖官方 `@larksuiteoapi/node-sdk`，给出长连接管理、事件归一化（消息/卡片/表情/评论/botAdded）、策略与安全（`requireMention`、`botLoopGuard`、去重、每 chat 串行）、出站（流式卡片、媒体），以及只读的 `channel.comments` 面（`resolveTarget` / `fetch` / `reply` / `addReaction`）。

**但不能在现有总线旁边再加一条连接。** `@larksuiteoapi/node-sdk` 明写 cluster 模式**不广播**：同一 app 多个客户端时**只有一个随机客户端收到**。所以这是**全有或全无**的替换，不是叠加。

**实测到的三个先决条件**（缺一是静默无事件）：① app 侧订阅该事件（控制台，长连接模式）；② 对该文档调一次 `POST /open-apis/drive/v1/files/:file_token/subscribe?file_type=<type>`（`file_type` 必须在查询串）；③ **触发者必须是人**——bot 给自己文档评论不产生通知（`is_from_agent:false` 是判据），这正是此前几轮「订阅成功 + 评论成功 + 零事件」的全部原因。

## 决策

1. **入站传输换成官方 `@larksuite/channel` 的长连接**，一个 app 只允许一个客户端；同一提交里**删掉两个 `lark-cli event consume` 子进程**，绝不留并存窗口（cluster 模式下并存等于随机丢事件）。
2. **只在边界做适配，不重写管线。**两个纯函数适配器（带测试）：
   - `NormalizedMessage → LarkMessageEvent`（`@chengchenccc/api-contract` 的共享 zod schema，snake_case）——`event_id` / `create_time` / `timestamp` 从 `raw` 取，`mention` 结构同理；
   - `CardActionEvent → 现有卡片行`：`raw.event_id` 当去重键、`operator.openId` 当 `operator_id`、**`action.value` 是解析好的对象 ⇒ `JSON.stringify` 一次**（或把 `decodeActionValue` 的入参放宽到 `unknown`）、`action.formValue` 扁平化成字符串表（现有逻辑复用）。
   **验收判据：`ingest` / `merge-hold` / `run-card/*` / `ahp-watcher` / bindings 的表结构一行不改。**
3. **卡片回调必须显式返回响应**（`CardActionResponse`，典型是 toast）。今天回包交给 lark-cli 的行协议，换层后是处理器契约；重活照旧离线跑，响应要在平台的等待窗口内返回。
4. **一条评论线 = 一个会话作用域**（与话题同构，ADR 0037 的不变量「回答回复进同一个地方、绝不另开一条」照搬）。新增 `comment_binding` 表（`conversation_id` ↔ `file_token` / `file_type` / `comment_id`），**不塞进 `topic_binding`**（key 语义不同）；投递 target 增加「评论线」一种，用 `channel.comments.reply(target, commentId, text)` 回进同一条评论线。
5. **只认 `mentionedBot`，并跳过自己发起的评论**。实测 bot 自评自不产生通知，但守卫仍要有（将来 agent 之间的评论会成为常态）。
6. **按文件订阅是产品步骤，不是可选优化**：被 @ 到的文档、以及聊天里贴过链接的文档要调一次 subscribe API，订阅状态落本地；v1 **不做全量订阅**（订阅哪些是有界的、可解释的）。
7. **建 app 向导要把三类事件订阅与 scope 申请链接透给用户**：消息 / 卡片回传交互 / 云文档评论，少一个是静默无事件；`99991672` 错误里的 `missing_scopes` 与 `console_url` 必须出现在界面上（今天本仓库对此零处理，实测建出来的 app 初始没有任何 scope）。
8. **lark-cli 保留**，角色收窄为：建 app 与凭据存储（`config init`、`~/.local/share/lark-cli` 的密钥库，SDK 用同一份凭据）、以及将来给 agent 当文档工具（甲那条路）。它**不再是事件通道**。
9. **不采纳 SDK 的卡片渲染 / 会话 / 队列层**：CardKit 流式卡、bindings、`merge-hold`、卡片去重与校验继续由我们拥有——它们与 run、审批、AHP 绑在一起。
10. **验收 = 隔离 app 上三条路各自端到端**：聊天消息 → run ✓；卡片按钮 → 回调被处理并回响应 ✓；真人评论 → run → 回答回复进同一条评论线 ✓。

## 后果

- 换层后「事件从哪里来」的差异被两个适配器收住，产品层行为应当**逐字不变**；任何行为差异都是 bug，不是特性。
- 多了一个 app 级配置前提（三类事件订阅）：配置错了的表现与「没有事件」完全相同 ⇒ 健康检查要能把它说出来（订阅状态 + 最后收到事件的时间）。
- 话题群里的 `threadId` / `rootId` 由 SDK 归一化自带（今天靠 raw API 反查），迁移后这部分可以简化——但**先不动**，等换层稳定。
- 未实测、留到验收：表单提交的回调形状、话题群里 `threadId/rootId` 的填充。

## 不做的

- 不做 webhook 模式（需要公网入口，与 bot 目前 no-public-ingress 的设计冲突）。
- 不做双客户端并存或按事件类型各走一条连接的混合形态（cluster 模式会随机丢事件）。
- 不订阅全部文档的评论事件（订阅集合必须有界、可解释）。
- 不改卡片渲染与 run 卡片生命周期（那一层与本次换层无关）。
- v1 不引入 SDK 的 meeting / media 面。
