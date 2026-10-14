# 路线

本页是唯一谈「还没做」的地方。wiki 的其余部分只描述代码此刻的样子，任何前瞻性的东西都收在这里，并写明它依赖哪些现有抽象。

外部对照与可吸收概念（全局搜索、提醒、任务可见化、agent 间协作窄路）单独记在 [Raft 产品概念吸收笔记](./notes/raft-product-notes.md)；那篇是方向输入，本页只记代码现状与缺口。

每一条都对着代码核过：不是「想做」，而是「确实没有」。做完就从上面对应的功能页补上描述，然后把这里的条目删掉。

## 怎么读这一页

分两类：

- **已知缺口**：代码里有半成品或死契约，或者某条路走不通。这类通常有明确的修法，缺的是时间与决策。
- **方向**：还没开始的设计，落地前要先回答它属于哪个已有领域对象。

## 执行的可靠性

**重启恢复已接线**（2026-09-25 复核）：`bootstrap/features.ts` 的 `start()` 先调 `agentRunExecution.recover()` 再调 `workflowExecutionService.recover()`（注释写明顺序理由：老状态先结算，Workflow 重驱时才不会在已被占用的分支上派发新 Run）。四类恢复都在：重投 `delivering` 输入、补崩溃期的排队长队、重试 `commit_failed`、把重启孤儿终结为 `aborted` 并提升队首。

**`commit_failed` 的残余：只在启动时重试一次。** 它算活跃状态（分支不接新 Run），而重试入口只有启动时的 `recover()`（会调 `retryTerminalCommit`）——所以「提交失败之后再提交还是失败」这种情况，运维要么重启后端，要么等下一次启动才重试；没有运行期的显式重试入口（`retryTerminalCommit` 在 service 上，但没暴露 HTTP）。真遇到再补一条 `POST /api/agent-runs/:id/retry-commit`，目前不投机加。

**HITL 状态机与重启恢复均已实现（ADR 0038，2026-09-28）。** 多槽语义（`waiting` ⇔ 至少一个 pending action，最后一个消费才唤醒，旧 action 重放不误唤醒）、审批重放幂等（同 decision 200 / 反 decision 409 / child 已不认识则 timeout 消费 + 409）、全局读模型 `GET /api/pending-actions`（Web 铃铛与 Today「Needs you」）都在。重启恢复：oma 对话消息实时落 session 文件、工具执行前写 **parked_turn 标记**；backend `recover()` 宽免停靠 run；回答以原 runId/原输入 + `resume.decisions` 重派，child 从标记补完中断轮（ask 答案注入、allow 审批真执行且人不重问、其余诚实落 interrupted）。剩余小项：**durable 行没有 deadline 列**（重启后停靠审批失去 child 侧 24h 超时，等答案或手动 stop，无自动过期）；Web/Lark 卡片对同一 run 的多个并发 action 仍一次渲染一张（全局列表兜底）；三个 CLI 后端的 ask 恢复是重派 + 重新问（内容匹配自动应答是增强，见 ADR 0038 决策 7）。

**子进程活着但沉默，run 与卡片都不知道。**（2026-09-25，两次真实 run。）适配器的读取器会在子进程退出后 5 秒内收尾（Bun `child.exited` + 孤儿管道宽限），所以「子进程死了不结算」并不成立。两条 run 的成因查清后是**两种**：其一的输入停在 `delivering`，即 `backend.execute` 从未返回——oma 适配器等子进程的 **acceptance 握手**没有超时，子进程 bootstrap 卡住（MCP 挂载、机器吃紧）就永久占住这一轮；**已修**（`acceptanceTimeoutMs`，默认 180 秒，超时 reap 子进程并以 `spawn_failed` 失败，测试用 `silent` 夹具钉住 + 变异验证）。另一个子问题是子进程**活着但数分钟零事件**（另一条 run 停在子代理委派之后），卡片只有计时器在走，唯一兜底是 30 分钟墙钟看门狗。**两条都做了（2026-09-25，`8c86284e`）**：②子进程每 15 秒发一个无副作用的 `heartbeat`（wire 上是 `{type:"status",status:"heartbeat"}`，事件总线刻意不持久化它），卡片与父侧据此区分「安静但活着」与「卡死」；①dispatch 侧的静默窗口默认 90 秒，但**有 pending action（正在等人）时豁免**——正是这条豁免关掉了「误杀一条跑十分钟的 bash」的风险。另外这次暴露的两个次要缺口：acceptance 的 180 秒上限会被 MCP 挂载的 120 秒调用上限撑满（挂载阶段该有自己的、更短的截止时间），以及取消后仍有子进程存活（实测一个取消过的 run 的子进程活了 8 分钟）。

## 上下文与历史

**~~产品摘要没有生产者~~（2026-10-13 已实现）。** `/compact` 现在真的压缩。后端按 `BACKEND_SUMMARY_MODEL=<provider>/<model>` 取模型——这是后端**第一条模型调用通路**（`createSummaryRuntime()` 从 `BUILTIN_CATALOG` 注册 provider，密钥每次调用时从 provider 设置解析，因此以后加密钥不必重启）。它把「保留尾部 20 条之外」的条目折成一条 `summary` 条目（`appendSummary` 记下覆盖点），并把上一次摘要的正文一起折进去；第二次压缩只覆盖上次覆盖点**之后**的新内容（已覆盖区域不重复计费）。未配置该变量时仍是 501 并说明原因，配置值畸形则在启动时直接失败。`/clear` 仍是真 no-op（没有运行时残留可清）。

**分叉与回滚没有产品入口。** `forkBranch` 唯一的非测试调用方是后端种类切换，`moveBranchLeaf` 只有测试在调，也没有任何 `/api/...branch|context` 路由。库里写了能力，产品上够不着。

**Context 的条目类型大半没人写。** `private_message`、`product_tool_exchange`、`model_change` 三种条目没有写入方，实际只有 `ledger_message` 在写。账本侧同理：`member.joined` / `member.left` 随成员表删除失去写入方，`todo` 从来没有过。

**Context 的裁剪是硬编码的。** 取 Run 时同步最近 20 条消息，没有可配置的预算，也没有按 token 估计的策略。做成可配之前得先决定预算归谁管。

## Workflow

**没有并行 fan-out。** ready 列表是串行 await 的，一条边分多路时不是并发执行。join 语义是 any-of，DSL 里也没有表达 AND 的标记。

## 模型与 provider

**自定义 provider 在产品里只读 `$OMA_HOME/models.yml`。** 这是刻意的（工作区文件是 agent 能写的地方，读它等于允许一次 Run 劫持下一次的 provider 地址），但用起来要有心理准备：要在产品里加 provider，得把 `OMA_HOME` 指到放 `models.yml` 的目录。

**模型目录里没有的成本核算。** 当前有按模型乘小时的费用汇总，没有预算上限：客户端按 24 小时曲线算配速，正式的封顶需要一个设置键加告警字段。

## 端

**飞书的会话绑定状态已同步到后端（2026-09-24）。** bot 的 30 秒心跳现在携带绑定聊天清单（chat、chat_mode、会话数、话题根），`getAgentRuntime` 原样透出（`surfaces.lark.chats`）——Web 的「飞书已绑定」与每 chat 策略 UI 的数据面已就绪，映射的权威源仍是 bot 自己的 SQLite（ADR 0037）。

**Lark Run 卡片第一期已落地**（ADR 0031：CardKit 直连流式投影、终态 canonical 封版、卡片「停止」按钮 + `/stop` 命令、重启恢复；终态可靠投递见 ADR 0032）。2026-09-24 追加：按钮回调经 lark-cli ≥1.0.9x 的 `card.action.trigger`，审批（批准/拒绝）与追问的选项按钮都已接（`answer_ask` 走 `/api/product-tools/ask/resolve`，与 Web 同一条路径）；卡片有过程视图（当前动作 + 已完成步骤 + todo 计划条）。同日第二批：**追问挂起时话题回复即答案**（`postMessage` 拦截，见「执行的可靠性」条）；**重启回读**（恢复卡在首帧前从 run 详情的 `pendingActions` 重建按钮，映射与活事件归约逐字段等价）；**回调去重与校验在位**（`reserveEventId` LRU 去重 + 全部 run 控制校验「卡片存在/chat 匹配/run 匹配」，测试钉住；operator 记录留痕）。仍欠：追问的**多选**提交（reaction 触发实测做不了、已删除，见 [lark.md](./architecture/surfaces/lark.md)：飞书没有可用于「停止」的负向表情）；签名 action token 维持 ADR 0031/0026 的延期决定（单用户部署，多操作者时再做）；**注意每应用卡片实体绑定配额**（200780，测试约 18 张触发）——高频使用需关注配额或提供 IM-patch 降级路径。

**Lark 卡片缺 artifact / diff / 完整日志的深链（2026-09-25 记录）。** 页脚目前只链到 Web 的 Run 页——方案里的「查看 Diff / 产物 / worktree」直达按钮，需要先把 artifact/diff 标识随 Run 事件（或 run 详情）传给 lark-bot；在那之前不给卡片加假的按钮。

**飞书云文档评论这个面没有**（2026-10-13 实测复核，issue #82 的结论落到这里）。想要的形态：文档里被 @ 到就起一个 run，回答**回复进同一条评论线**（与聊天面「回复同一个话题、绝不另开一条」是同一条不变量）。三件事分别核实过：

- **读/写评论的命令有了** ✓ —— `lark-cli` 1.0.96 的 `drive +list-comments` / `+list-replies` / `+add-reply`（含 `--dry-run`、`--as user|bot`、wiki 链接解包）与 `docs +fetch/+update/+search`。但全仓 `lark-cli` 的调用点**全在 provision**（`features/lark-bot/{profile,provisioner,setup-manager}.ts` 等 15 个文件），**没有包成 agent 的工具面** ⇒ 产品里够不着（agent 自己撞 PATH 不算产品能力）。
- **触发这条路实测封死** ✗ —— `lark-cli event list --json` = 25 个键、9 个域（im:11 vc:7 approval:2 application/board/card/minutes/task 各 1），**没有 drive**；`event schema` 与 `event consume drive.notice.comment_add_v1` 都当场返回 `unknown EventKey`（是拒绝，不是静默失败）。**2026-10-14 追到上游核对了出处**：上游仓库 `events/` 的子目录正是这 9 个域，**没有 drive**（`events/internal/` 只有通用的 `subscribe` / `prep`）；CLI 二进制里那个字符串只出现在**内嵌的 OpenAPI schema** 里 —— 它是云文档文件事件订阅 API（`/open-apis/drive/v1/files/:file_token/subscribe`，同族还有 `get_subscribe` / `delete_subscribe` / `subscriptions/:id` / `new_comments`；scope `docs:document.comment:read`，accessTokens user+tenant）的 `event_type` 参数，可选值就这一个 ⇒ **CLI 的接口目录认识这个事件名，但既没有命令暴露订阅、也没有可订阅的 EventKey**（`drive --help` 的 40 多条命令全列过，只有评论的读写，没有订阅）。另外：二进制里那个 `/open-apis/drive/v1/lark_cli_file_event/report` 是 CLI 专用端点，来历是 CHANGELOG 的「- report upload file events (#2093)」—— **上传**事件的上报，与接收评论事件无关。结论：**「支持但没暴露」只对了一半** —— 平台侧、SDK 侧、CLI 的接口目录都有原料，缺的是 CLI 的暴露面与接收通路。而且上游源码证实这是**有意为之**：`events/all.go` 的 `All()` 只聚合 7 个域（application/approval/im/minutes/task/vc/whiteboard），注释原话「Mail is intentionally omitted in this phase」—— **「整个域按阶段略过」是项目自己写明的工作方式**，drive 大概率同类。加一个域的形态也很清楚：一个 `events/<域>/` 包，里面几个 Go 文件声明 `catalog.KeyDefinition` + handler + 测试（im 域是 `message_receive.go` / `card_action.go` / `native.go` / `register.go`），`All()` 只是把它们 append 起来 ⇒ 「向上游提 issue/PR」是一条**范围清晰**的路。另外 `event consume` 带 `-p/--param Key=value` ⇒ 将来的 drive 域键很可能是带 `file_token` 参数的。
- **平台上是有这个事件的** ✓ —— 官方 `@larksuite/channel`（依赖 `@larksuiteoapi/node-sdk`）给出 `on('comment')` → `CommentEvent{fileToken,fileType,commentId,replyId?,operator,mentionedBot,timestamp}` 与只读的 `comments.{resolveTarget,fetch,reply,addReaction}`。SDK 把 `drive.notice.comment_add_v1` 挂在**同一个 dispatcher** 的 `builtinHandlers` 上（与 `im.message.receive_v1`、卡片回调同一条路），并会按需注册事件类型；但它**不**替调用方去调 `/files/:token/subscribe`（整个包里 `drive/v1/files` 只出现一次，是回评论的 URL）⇒ **评论事件是否经长连接到达，取决于 app 侧的事件订阅配置，这一点尚未验证** ✗。若平台只按 webhook（事件回调地址）投递，SDK 的 `transport: 'webhook'` 是备选，但那需要公网入口，与 bot 目前「no public ingress」的设计直接冲突。**权限模型证实了「先订阅文件」这一步** ✓ —— CLI 内嵌 schema 里的 scope 名字直接写着 `docs:document.subscription` / `docs:document.subscription:read` / `docs:event:subscribe` / `docs:document.comment:read` / `docs:document.comment:create` / `docs:document:import` ⇒ 云文档事件是**按文件订阅**的机制 ✓（`POST /open-apis/drive/v1/files/:file_token/subscribe {event_type:"drive.notice.comment_add_v1"}` ✓），不是「装了 app 就自动收」✗。这给丙添了一条设计问题：订阅哪些文档（聊天里贴过的？被拉成协作者的？全部？）、订阅状态存哪。另记一个**产品缺口**：本仓库对 `scope-apply` / `99991672`（`app_scope_not_applied`）**零处理** ✗ —— `lark-cli config init --new` 建出来的 app **初始没有任何 scope** ✓（实测第一次调用即失败，授权链接塞在错误对象的 `hint` 与 `console_url` 里 ✓），我们自己的建 app 向导走到这一步同样会卡 ✓，该把 `missing_scopes` / `console_url` 透给用户。
- **但不能在现有总线上再加一条事件源** ✗ —— `@larksuiteoapi/node-sdk` 明写 cluster 模式**不广播**：「if multiple clients are deployed for the same application, only one random client will receive the message」⇒ 再开一条 WS 会**随机吃掉**总线上现有的 im/卡片事件，症状是「消息时丢时不丢」，最难查的那类。

三条路（未选）：**甲**＝只做工具，agent 能读文档与评论当上下文，触发靠「在聊天里贴文档链接」，零事件层风险；**丙**＝整体把 bot 的事件层换成官方 channel SDK（全有或全无：评论、卡片、媒体、归一化都由官方维护，`lark-cli` 退回给 agent 当工具），落地前要 ADR，且**必须先验两件事**：① 评论事件确实经长连接到达（若不是，整条路线要额外引入公网入口或隧道，量级完全不同）；② 卡片回调在 SDK 下的**载荷形状**与我们 `handleCardActionLine` 吃的一致。丙的验证必须**另建测试 app**（在生产 app 上做这个实验会真的丢消息）。参考实现 [lark-channel-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge) 就是丙的形态（它持有该 app 唯一的长连接 ✓，产品层自己写 ✓），可抄的纪律：只认 `mentionedBot`、跳过自己发的回复（bot-loop guard）、**一条评论线 = 一个 session 作用域**、给触发那条加 reaction 当已读标记、回复进同一条评论线；**丁**＝给上游提 issue/PR 加 `events/drive` 域（官方仓、MIT，`events/all.go` 自己写明按阶段略过整域），范围清晰但要等合并，不阻塞前两条。

**知识库只有文件级。** 没有 chunk 级检索、也没有重建索引与试查询端点；统计里的 token 与 chunk 数是估算。**2026-10-13 更新（ADR 0043 决定 7）**：语义检索**已实现但默认关闭** ✓ —— embedding 缝、向量索引（全有或全无 ✓、内容签名判失效 ✓、段落切块 1500 字符 × 每文件上限 200 ✓）、查询降级（无索引或建不起来时退回词法**并说明原因** ✓）、播种与索引解耦（安装不依赖 embedding ✓）都已落地并带测试。默认关闭的原因是实测：本机知识包 39 页 = **1547 块**，每块 11～20 秒 ⇒ 全量构建 **5～7 小时** ✗；唯一质量合格的多语言模型就是这个速度，快一点的小模型中文排序是错的 ✗。因此默认不配 `BACKEND_EMBEDDING_*`（行为与旧版逐字一致 ✓），换到便宜的机器（GPU／更小语料／可用云 key）配两行即生效。

**技能包的调用计数没有。** 设计里有「今日调用」这类统计，需要工具调用事件带上来源包 id。

**配置期的 `(backendKind, model)` 一致性校验已补（2026-09-24）。** `POST/PATCH /api/agents` 现在会把 `provider/model`（经 `MODEL_ALIASES` 归一）对照目标种类的目录，目录里没有就 400（`model-check.ts`；目录列不出来时降级为放行，配置不依赖子进程活着）。PATCH 只换 `backendKind` 时也会用旧模型对新目录查一次——这是当初真机翻车的那条路（`oma + deepseek/deepseek-chat` → 200，run 阶段才死）。

## 安全

完整清单在 [安全与债务清单](./architecture/security/debt.md)，这里只列需要设计决策的那几条：

**bash 的网络白名单。** 现在只有「全断网」和「全开」两种，没有中间档；要放行特定的 registry 就得写策略。

**MCP 面的三件事。** stdio 的 CRUD 允许任意命令（等于 token 持有者就是宿主机 shell）、读取单个 server 时明文返回凭据、url server 挂载前没有 SSRF 检查。

**原生工具的细粒度权限。** 现在只有按工具名的高危清单与 auto 分类器，没有 allow-rules 那种按参数放行的机制。

**文件权限。** provider 密钥明文存在 SQLite 里，`dataDir`、`backend.db`、backend 的 `.env` 权限都是 0644。

**网络化部署的准入门槛**（离开回环地址之前必须做掉）：bash 网络白名单、MCP 凭据加密存储与 SSRF guard、移除 mock 登录表面、原生工具 allow-rules。

## 内容分发

**内置包只在源目录指纹变化时刷新。** 修好了：`seedSkillPacks` 与知识包的 `syncBuiltin` 现在会比对源目录指纹（`directoryFingerprint`，存在 `sourceRev` 上），不一致就用 staging 目录加 rename 换掉；知识包刷新后还会重跑一次受影响 Agent 的 reconcile，否则注入的 `knowledge/index.md` 仍是旧的。

仍然粗糙的地方有两处：指纹是整目录 sha256，源目录每变一个字就要整包重拷（包里若有几百个文件，启动会多几百毫秒）；刷新只发生在启动，长时间不重启的进程要等下一次重启才看到仓库里的新文档。

## 界面

**Run 的跨度追踪只做了第一层。** 现在能从 `agent_run_event` 推出工具调用与模型轮次的瀑布图，没有传输层（spawn、管道、写库）的耗时。要加就得在适配器里埋点，而且必须保持「跨度是 Run 级遥测，不是第二个执行身份」——Phase 6 删掉旧 span 表就是为了防这个。

**Run 的中途暂停没有。** 现在只有停止。暂停需要子进程能在中途存状态并在恢复命令后接着跑，牵动 oma 的循环、适配器协议与输入队列语义。

## 开发流程

**测试吃的是 workspace 的 dist，不是源码。** 2026-09-26 实测：`packages/api-contract` 的源码已导出 `hasDedicatedEvent` 而 dist 没有，`run-card.test.ts` 直接因此起不来，先 `bun run --filter @chengchenccc/api-contract build` 才恢复。也就是说：改了 `packages/{api-contract,message,ai,agent-contract}` 这类被 app 依赖的包之后，本地测试结果可能反映的是**旧产物**——绿灯可能是假的。两条修法（未选）：①workspace 内部解析一律指向 `src`（`exports` 加 development 条件或 tsconfig paths），dist 只服务外部消费者；②保持现状，但把「先按拓扑构建依赖」写进开发指南并在 CI 显式排序。倾向 ①：它消灭这一类问题，而不是提醒人绕开。

## 明确不做的

- `workflowRef.repo` 的 git loader：定义只从本地目录（`config.dataDir/workflows`）读，请求里的 `repo` 现在可选且被忽略。按请求去 clone 任意仓库是个安全面，要用时把 loader 与这个字段一起带回来。
- **上下文降级（context promotion / 中途换大窗模型）。** omp 在溢出时**优先**换成更大窗口的模型重试、不压缩；本仓库**不做**：run 的模型由后端冻结在快照里（`AgentRunSnapshot.model` + `configRevision`），中途换模型要么改子进程协议（快照、终态、表面三处都得带上模型变更），要么退化成「后端拿同一个输入重派一个新 run」（那才是适配本仓库的形态：每次 run 本来就新起子进程）。当前已有三条防线——按**储备量**推出的触发线（大窗不再白留 60k）、一次性溢出恢复、以及**截断当步就压缩**——溢出已属罕见，所以先只把路留在这里。真要做，就先做「按 agent 配一个更大窗口的兜底模型」+「换模型必须在表面可见」（否则是费用惊喜），并只在实测反复出现溢出恢复时才启动。
- Claude 的 hooks.json 协议、commands、agents、LSP。
- jiti 之类的运行时转译：插件加载一律用 Bun 原生 `import()`。
