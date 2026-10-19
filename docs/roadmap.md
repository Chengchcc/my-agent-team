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

**子进程活着但沉默，run 与卡片都不知道。**（2026-09-25，两次真实 run。）适配器的读取器会在子进程退出后 5 秒内收尾（Bun `child.exited` + 孤儿管道宽限），所以「子进程死了不结算」并不成立。两条 run 的成因查清后是**两种**：其一的输入停在 `delivering`，即 `backend.execute` 从未返回——oma 适配器等子进程的 **acceptance 握手**没有超时，子进程 bootstrap 卡住（MCP 挂载、机器吃紧）就永久占住这一轮；**已修**（`acceptanceTimeoutMs`，默认 180 秒，超时 reap 子进程并以 `spawn_failed` 失败，测试用 `silent` 夹具钉住 + 变异验证）。另一个子问题是子进程**活着但数分钟零事件**（另一条 run 停在子代理委派之后），卡片只有计时器在走，唯一兜底是 30 分钟墙钟看门狗。**两条都做了（2026-09-25，`8c86284e`）**：②子进程每 15 秒发一个无副作用的 `heartbeat`（wire 上是 `{type:"status",status:"heartbeat"}`，事件总线刻意不持久化它），卡片与父侧据此区分「安静但活着」与「卡死」；①dispatch 侧的静默窗口默认 90 秒，但**有 pending action（正在等人）时豁免**——正是这条豁免关掉了「误杀一条跑十分钟的 bash」的风险。另外这次暴露的两个次要缺口：acceptance 的 180 秒上限会被 MCP 挂载的 120 秒调用上限撑满（挂载阶段该有自己的、更短的截止时间），以及 ~~取消后仍有子进程存活~~（**2026-10-16 修复**）。成因查清了：取消只把 execution 标成 cancelled、让节点轮询抛出，从不 `stop` 掉节点在飞的 run ⇒ 那条 run 永远停在 `waiting`（而带 pending action 的 run 被静默看门狗豁免，因为它看起来像「正在等人」），子进程就一直空转——实测一条已完成 run 的 ACP 子进程活了 **65 分钟**，按完整 run id 取消它 30 秒后进程归零，绑定关系由此坐实。现在取消/失败一条 execution 会先 `stopNodeRun`（stop + 有界等结算）再抛出，超时路径共用同一段收尾，测试钉住（拿掉那行即红）。

## 上下文与历史

**~~产品摘要没有生产者~~（2026-10-13 已实现）。** `/compact` 现在真的压缩。后端按 `BACKEND_SUMMARY_MODEL=<provider>/<model>` 取模型——这是后端**第一条模型调用通路**（`createSummaryRuntime()` 从 `BUILTIN_CATALOG` 注册 provider，密钥每次调用时从 provider 设置解析，因此以后加密钥不必重启）。它把「保留尾部 20 条之外」的条目折成一条 `summary` 条目（`appendSummary` 记下覆盖点），并把上一次摘要的正文一起折进去；第二次压缩只覆盖上次覆盖点**之后**的新内容（已覆盖区域不重复计费）。未配置该变量时仍是 501 并说明原因，配置值畸形则在启动时直接失败。`/clear` 仍是真 no-op（没有运行时残留可清）。

**~~分叉与回滚没有产品入口~~（2026-10-16 核对：入口已有，原判断过时）。** 三条路都在产品上：`POST /api/conversations/:id/fork`（从某条消息起新建会话）、`/undo`（墓碑式软撤销，账本项标 `undone`）、`/replay`（改一条再新建），web 侧在 `TimelineMessageActions` 的悬停动作里。库里唯一够不着的是 `forkBranch`，而它只被后端种类切换用，本来就不需要产品入口；另一条零调用方的硬回退原语（`moveBranchLeaf`）同日删除。

**~~Context 的条目类型大半没人写~~（2026-10-19 已收窄）。** `private_message`、`product_tool_exchange`、`model_change` 三种条目从来没有写入方，连同端口、服务、适配器、投影分支与测试一起删掉了，条目联合只剩 `ledger_message | summary`。换模型的产品入口是会话输入框上的 `ModelPicker`（按会话持久化、随每条消息下发），所以分支级的隐形 pin 不是缺口而是重复。账本侧**已经清过**（2026-10-19 复核）：`apps/backend/src/features/conversation/ledger-codec.ts` 的 `LedgerKind` 只剩 `message | surface.control | undo`，`member.joined` / `member.left` / `todo` 三种历史残留已删，注释写明理由（只保留有写入方的值）。

**Context 的裁剪是硬编码的。** 取 Run 时同步最近 20 条消息，没有可配置的预算，也没有按 token 估计的策略。做成可配之前得先决定预算归谁管。

## Workflow

**没有并行 fan-out。** ready 列表是串行 await 的，一条边分多路时不是并发执行。join 语义是 any-of，DSL 里也没有表达 AND 的标记。

## 模型与 provider

**自定义 provider 在产品里只读 `$OMA_HOME/models.yml`。** 这是刻意的（工作区文件是 agent 能写的地方，读它等于允许一次 Run 劫持下一次的 provider 地址），但用起来要有心理准备：要在产品里加 provider，得把 `OMA_HOME` 指到放 `models.yml` 的目录。

**~~模型目录里没有的成本核算~~（2026-10-16 已实现）。** `cost.dailyBudgetUsd`（设置项，数字或数字串都认）封顶「本地日」的目录价花费：超了就在派发前拒掉，run 的终态带上「daily budget exhausted: $X of the $Y cap」，还没认领输入、没起子进程；没配就是不封顶，配了脏值当没配（不是当零）。`/api/usage/summary` 的 `budget` 与拒绝走同一个 gate，两边不可能各说各话。仍未做的是**告警字段**（快到上限时提醒）与按 24 小时曲线的配速。

## 端

**飞书的会话绑定状态已同步到后端（2026-09-24）。** bot 的 30 秒心跳现在携带绑定聊天清单（chat、chat_mode、会话数、话题根），`getAgentRuntime` 原样透出（`surfaces.lark.chats`）——Web 的「飞书已绑定」与每 chat 策略 UI 的数据面已就绪，映射的权威源仍是 bot 自己的 SQLite（ADR 0037）。

**Lark Run 卡片第一期已落地**（ADR 0031：CardKit 直连流式投影、终态 canonical 封版、卡片「停止」按钮 + `/stop` 命令、重启恢复；终态可靠投递见 ADR 0032）。2026-09-24 追加：按钮回调经 lark-cli ≥1.0.9x 的 `card.action.trigger`，审批（批准/拒绝）与追问的选项按钮都已接（`answer_ask` 走 `/api/product-tools/ask/resolve`，与 Web 同一条路径）；卡片有过程视图（当前动作 + 已完成步骤 + todo 计划条）。同日第二批：**追问挂起时话题回复即答案**（`postMessage` 拦截，见「执行的可靠性」条）；**重启回读**（恢复卡在首帧前从 run 详情的 `pendingActions` 重建按钮，映射与活事件归约逐字段等价）；**回调去重与校验在位**（`reserveEventId` LRU 去重 + 全部 run 控制校验「卡片存在/chat 匹配/run 匹配」，测试钉住；operator 记录留痕）。仍欠：追问的**多选**提交（reaction 触发实测做不了、已删除，见 [lark.md](./architecture/surfaces/lark.md)：飞书没有可用于「停止」的负向表情）；签名 action token 维持 ADR 0031/0026 的延期决定（单用户部署，多操作者时再做）；**注意每应用卡片实体绑定配额**（200780，测试约 18 张触发）——高频使用需关注配额或提供 IM-patch 降级路径。

**Lark 卡片缺 artifact / diff / 完整日志的深链（2026-09-25 记录）。** 页脚目前只链到 Web 的 Run 页——方案里的「查看 Diff / 产物 / worktree」直达按钮，需要先把 artifact/diff 标识随 Run 事件（或 run 详情）传给 lark-bot；在那之前不给卡片加假的按钮。

**飞书云文档评论这个面已实现（ADR 0044，2026-10-14）** —— 原先那段实测链已随「条目做完即删」的规矩移除，证据留在 ADR 里；决策、实现形状与代码位置见 [ADR 0044](./adr/0044-lark-inbound-events-official-channel-sdk.md)，运行时的不变量见 [lark.md](./architecture/surfaces/lark.md)。**只剩一项**：生产 app 补齐事件订阅与 scope 后的端到端验收（消息 / 卡片 / 评论三条路）——这是运维动作，不是代码。原列表里另外两项（2026-10-19 复核为已完成）：① Web 面板**已经在渲染** console 引导（`apps/web/src/features/lark/LarkSurfacePanel.tsx` 输出 `Console events: …` 与 scope 申请链接，链接只在 `scopeApplyUrl` 非空时给，从不发明 URL）；② 适配器把 `threadId` / `rootId` 原样传下去（`apps/lark-bot/src/channel-adapters.ts`，缺失就不填）。（这次复核的教训：查「谁渲染」要看**数据字段**而不是函数名——`larkSetupGuidance` 在 web 里确实零引用，但渲染用的是 surface 视图的 `console` 字段。）

**知识库只有文件级。** 没有 chunk 级检索、也没有重建索引与试查询端点；统计里的 token 与 chunk 数是估算。**2026-10-13 更新（ADR 0043 决定 7）**：语义检索**已实现但默认关闭** ✓ —— embedding 缝、向量索引（全有或全无 ✓、内容签名判失效 ✓、段落切块 1500 字符 × 每文件上限 200 ✓）、查询降级（无索引或建不起来时退回词法**并说明原因** ✓）、播种与索引解耦（安装不依赖 embedding ✓）都已落地并带测试。默认关闭的原因是实测：本机知识包 39 页 = **1547 块**，每块 11～20 秒 ⇒ 全量构建 **5～7 小时** ✗；唯一质量合格的多语言模型就是这个速度，快一点的小模型中文排序是错的 ✗。因此默认不配 `BACKEND_EMBEDDING_*`（行为与旧版逐字一致 ✓），换到便宜的机器（GPU／更小语料／可用云 key）配两行即生效。

**技能包的调用计数没有。** 设计里有「今日调用」这类统计，需要工具调用事件带上来源包 id。

**配置期的 `(backendKind, model)` 一致性校验已补（2026-09-24）。** `POST/PATCH /api/agents` 现在会把 `provider/model`（经 `MODEL_ALIASES` 归一）对照目标种类的目录，目录里没有就 400（`model-check.ts`；目录列不出来时降级为放行，配置不依赖子进程活着）。PATCH 只换 `backendKind` 时也会用旧模型对新目录查一次——这是当初真机翻车的那条路（`oma + deepseek/deepseek-chat` → 200，run 阶段才死）。

## 安全

完整清单在 [安全与债务清单](./architecture/security/debt.md)，这里只列需要设计决策的那几条：

**bash 的网络白名单。** 现在只有「全断网」和「全开」两种，没有中间档；要放行特定的 registry 就得写策略。

**MCP 面的三件事。** stdio 的 CRUD 允许任意命令（等于 token 持有者就是宿主机 shell）、读取单个 server 时明文返回凭据、url server 挂载前没有 SSRF 检查。

**原生工具的细粒度权限。** 现在只有按工具名的高危清单与 auto 分类器，没有 allow-rules 那种按参数放行的机制。

**文件权限。** provider 密钥明文存在 SQLite 里，`dataDir`、`backend.db`、backend 的 `.env` 权限都是 0644。

**网络化部署的准入门槛**（离开回环地址之前必须做掉）：bash 网络白名单、MCP 凭据加密存储、原生工具 allow-rules。（**MCP url server 的 SSRF guard 已完成**，2026-10-19：metadata 地址永远拒绝、私网目标在后端监听非回环时拒绝、检查在连接处做；剩下的加密存储要先回答「密钥放哪」。）（**「移除 mock 登录表面」已核销**，2026-10-19：登录永远要密码，未配置时 fail-closed；`MOCK_USER_ID` / `MOCK_PASSWORD` 只是命名遗留，见[安全与债务清单](./architecture/security/debt.md)的网络化部署一节。）

## 内容分发

**内置包只在源目录指纹变化时刷新。** 修好了：`seedSkillPacks` 与知识包的 `syncBuiltin` 现在会比对源目录指纹（`directoryFingerprint`，存在 `sourceRev` 上），不一致就用 staging 目录加 rename 换掉；知识包刷新后还会重跑一次受影响 Agent 的 reconcile，否则注入的 `knowledge/index.md` 仍是旧的。

仍然粗糙的地方有两处：指纹是整目录 sha256，源目录每变一个字就要整包重拷（包里若有几百个文件，启动会多几百毫秒）；刷新只发生在启动，长时间不重启的进程要等下一次重启才看到仓库里的新文档。

## 界面

**Run 的跨度追踪只做了第一层。** 现在能从 `agent_run_event` 推出工具调用与模型轮次的瀑布图，没有传输层（spawn、管道、写库）的耗时。要加就得在适配器里埋点，而且必须保持「跨度是 Run 级遥测，不是第二个执行身份」——Phase 6 删掉旧 span 表就是为了防这个。

**Run 的中途暂停没有。** 现在只有停止。暂停需要子进程能在中途存状态并在恢复命令后接着跑，牵动 oma 的循环、适配器协议与输入队列语义。

## 开发流程

**~~测试吃的是 workspace 的 dist，不是源码~~（2026-10-16 已修）。** 包入口一律指向 `src/index.ts`，本地测试与 dev 永远吃到刚写的源码；发布时 release stamp 步骤把每个 src 入口改写回 dist 的孪生文件后再 pack（npm 消费者不变）。唯一例外 `tui`（vendored mermaid 的 `.ts` 后缀导入 × 会产出的 tsc 无法开 `allowImportingTsExtensions`，其唯一消费方 oma 正是会产出的 tsc 构建），留在 dist 并在包里以 `x-why-dist` 记录。

## 明确不做的

- `workflowRef.repo` 的 git loader：定义只从本地目录（`config.dataDir/workflows`）读，请求里的 `repo` 现在可选且被忽略。按请求去 clone 任意仓库是个安全面，要用时把 loader 与这个字段一起带回来。
- **上下文降级（context promotion / 中途换大窗模型）。** omp 在溢出时**优先**换成更大窗口的模型重试、不压缩；本仓库**不做**：run 的模型由后端冻结在快照里（`AgentRunSnapshot.model` + `configRevision`），中途换模型要么改子进程协议（快照、终态、表面三处都得带上模型变更），要么退化成「后端拿同一个输入重派一个新 run」（那才是适配本仓库的形态：每次 run 本来就新起子进程）。当前已有三条防线——按**储备量**推出的触发线（大窗不再白留 60k）、一次性溢出恢复、以及**截断当步就压缩**——溢出已属罕见，所以先只把路留在这里。真要做，就先做「按 agent 配一个更大窗口的兜底模型」+「换模型必须在表面可见」（否则是费用惊喜），并只在实测反复出现溢出恢复时才启动。
- Claude 的 hooks.json 协议、commands、agents、LSP。
- jiti 之类的运行时转译：插件加载一律用 Bun 原生 `import()`。
