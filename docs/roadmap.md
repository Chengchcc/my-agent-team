# 路线

本页是唯一谈「还没做」的地方。wiki 的其余部分只描述代码此刻的样子，任何前瞻性的东西都收在这里，并写明它依赖哪些现有抽象。

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

**产品摘要没有生产者。** Context 的 `summary` 条目类型与投影逻辑都在（投影遇到它会用它覆盖被覆盖的那段），但 `appendSummary` 只有测试在调；对话的 `/compact` 与 `/clear` 是显式空操作。要么做一个产品侧的压缩策略，要么把这条路径删掉——留着最容易被误读成「已经有产品级压缩」。

**分叉与回滚没有产品入口。** `forkBranch` 唯一的非测试调用方是后端种类切换，`moveBranchLeaf` 只有测试在调，也没有任何 `/api/...branch|context` 路由。库里写了能力，产品上够不着。

**Context 的条目类型大半没人写。** `private_message`、`product_tool_exchange`、`model_change` 三种条目没有写入方，实际只有 `ledger_message` 在写。账本侧同理：`member.joined` / `member.left` 随成员表删除失去写入方，`todo` 从来没有过。

**契约里有三个事件没人发。** `product_tool_started`、`product_tool_completed`、`pending_action` 在 `agent-contract` 里声明着，全仓没有发送点。要么实现，要么从契约里删掉。

**Context 的裁剪是硬编码的。** 取 Run 时同步最近 20 条消息，没有可配置的预算，也没有按 token 估计的策略。做成可配之前得先决定预算归谁管。

## Workflow

**human 节点的 `timeoutMs` 没实现。** 字段能解析，但从没被消费，pending human 会一直等到人来。

**没有并行 fan-out。** ready 列表是串行 await 的，一条边分多路时不是并发执行。join 语义是 any-of，DSL 里也没有表达 AND 的标记。

**agent 节点的 `repo` 是死接线。** 字段进了 `NodeContext`，依赖也在组装点接好了，但没有调用方，agent 节点不会切到那个仓库的 worktree。

**`workflowRef.repo` 被忽略。** 定义只从本地目录读，没有 git loader。

**script 节点的契约与实现不符。** `packages/workflow/src/node-runtime.ts` 里的 `ScriptContext` 声明了 store、context、log，但后端只把裸 input 传进去，宿主对象刻意不进沙箱。结果这个契约是死的，照它写脚本会崩；`store_write` 事件因此永远不会触发。

## 模型与 provider

**自定义 provider 在产品里只读 `$OMA_HOME/models.yml`。** 这是刻意的（工作区文件是 agent 能写的地方，读它等于允许一次 Run 劫持下一次的 provider 地址），但用起来要有心理准备：要在产品里加 provider，得把 `OMA_HOME` 指到放 `models.yml` 的目录。

**模型目录里没有的成本核算。** 当前有按模型乘小时的费用汇总，没有预算上限：客户端按 24 小时曲线算配速，正式的封顶需要一个设置键加告警字段。

## 端

**飞书的会话绑定状态已同步到后端（2026-09-24）。** bot 的 30 秒心跳现在携带绑定聊天清单（chat、chat_mode、会话数、话题根），`getAgentRuntime` 原样透出（`surfaces.lark.chats`）——Web 的「飞书已绑定」与每 chat 策略 UI 的数据面已就绪，映射的权威源仍是 bot 自己的 SQLite（ADR 0037）。

**Lark Run 卡片第一期已落地**（ADR 0031：CardKit 直连流式投影、终态 canonical 封版、卡片「停止」按钮 + `/stop` 命令、重启恢复；终态可靠投递见 ADR 0032）。2026-09-24 追加：按钮回调经 lark-cli ≥1.0.9x 的 `card.action.trigger`，审批（批准/拒绝）与追问的选项按钮都已接（`answer_ask` 走 `/api/product-tools/ask/resolve`，与 Web 同一条路径）；卡片有过程视图（当前动作 + 已完成步骤 + todo 计划条）。同日第二批：**追问挂起时话题回复即答案**（`postMessage` 拦截，见「执行的可靠性」条）；**重启回读**（恢复卡在首帧前从 run 详情的 `pendingActions` 重建按钮，映射与活事件归约逐字段等价）；**回调去重与校验在位**（`reserveEventId` LRU 去重 + 全部 run 控制校验「卡片存在/chat 匹配/run 匹配」，测试钉住；operator 记录留痕）。仍欠：追问的**多选**提交（reaction 触发实测做不了、已删除，见 [lark.md](./architecture/surfaces/lark.md)：飞书没有可用于「停止」的负向表情）；签名 action token 维持 ADR 0031/0026 的延期决定（单用户部署，多操作者时再做）；**注意每应用卡片实体绑定配额**（200780，测试约 18 张触发）——高频使用需关注配额或提供 IM-patch 降级路径。

**产物缺内容账本与保留策略。** 来源信息有了（meta 文件加列表接口），缺 sha256 内容账本与校验端点、保留期的定时清理、以及主动清除接口。

**Lark 卡片缺 artifact / diff / 完整日志的深链（2026-09-25 记录）。** 页脚目前只链到 Web 的 Run 页——方案里的「查看 Diff / 产物 / worktree」直达按钮，需要先把 artifact/diff 标识随 Run 事件（或 run 详情）传给 lark-bot；在那之前不给卡片加假的按钮。

**知识库只有文件级。** 没有 embedding 流水线、向量存储、chunk 级检索；统计里的 token 与 chunk 数是估算，没有重建索引和试查询端点。

**技能包的调用计数没有。** 设计里有「今日调用」这类统计，需要工具调用事件带上来源包 id。

**配置期的 `(backendKind, model)` 一致性校验已补（2026-09-24）。** `POST/PATCH /api/agents` 现在会把 `provider/model`（经 `MODEL_ALIASES` 归一）对照目标种类的目录，目录里没有就 400（`model-check.ts`；目录列不出来时降级为放行，配置不依赖子进程活着）。PATCH 只换 `backendKind` 时也会用旧模型对新目录查一次——这是当初真机翻车的那条路（`oma + deepseek/deepseek-chat` → 200，run 阶段才死）。

**omp 静态表已对齐实际可跑面（2026-09-24）。** `packages/adapter-omp-agent/src/model-catalog.ts` 现在只列部署 `models.yml` 真正声明的 `deepseek-v4-pro`/`deepseek-v4-flash`——`deepseek-chat`/`deepseek-reasoner` 实测会让 omp 启动即 fatal（回落到无 key 的默认 openrouter provider），不再出现在可选列表；元数据也换成了实测值。`available: true` 仍是硬编码（adapter 读不到 omp 自己 models.yml 里的内联 key），但配置期 `(backendKind, model)` 校验和 `/api/models` 的服务探测已把真正的诚实缺口补上。

## 安全

完整清单在 [安全与债务清单](./architecture/security/debt.md)，这里只列需要设计决策的那几条：

**bash 的网络白名单。** 现在只有「全断网」和「全开」两种，没有中间档；要放行特定的 registry 就得写策略。

**审批里的 `sandboxed` 信号没接线。** 字段存在但恒为 false，所以「已沙箱化的命令自动放行、未沙箱化的走审批」这条设计没有落地，bash 沙箱目前只能靠设置手动开。

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

- omp `CustomTool` 的模块形状兼容（ArkType 三栖 schema 加 `CustomToolAPI` 工厂，等于移植半个 pi 运行时）。
- Claude 的 hooks.json 协议、commands、agents、LSP。
- jiti 之类的运行时转译：插件加载一律用 Bun 原生 `import()`。
