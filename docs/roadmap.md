# 路线

本页是唯一谈「还没做」的地方。wiki 的其余部分只描述代码此刻的样子，任何前瞻性的东西都收在这里，并写明它依赖哪些现有抽象。

每一条都对着代码核过：不是「想做」，而是「确实没有」。做完就从上面对应的功能页补上描述，然后把这里的条目删掉。

## 怎么读这一页

分两类：

- **已知缺口**：代码里有半成品或死契约，或者某条路走不通。这类通常有明确的修法，缺的是时间与决策。
- **方向**：还没开始的设计，落地前要先回答它属于哪个已有领域对象。

## 执行的可靠性

**重启恢复没有接线。** `recover()` 实现了四类恢复（重投 `delivering` 输入、补崩溃期间的排队长队、重试 `commit_failed`、清理孤儿），但启动时只调用了 Workflow 的 `recover()`。后果：进程重启后之前的状态一直躺着，直到那个对话来了新消息才被动触发僵尸清理。

**`commit_failed` 会把分支永久占住。** 它算活跃状态，所以那个分支不会再接新 Run；而唯一的重试入口在没被调起的恢复函数里。修法是把 `recover()` 接上，或者给提交失败一条独立的退路。

**HITL 的持久化差最后一环：Lark 可见。** approval 与 ask 都已走 durable PendingAction v1（`approval_request`/`ask_question` 写 `pending_action` 表，run CAS `running→waiting`，回答与超时经 `consumePendingAction` 修复回 `running`）。超时语义已补齐（2026-09-25）：oma 循环层的审批等待自带截止时间（默认 24 小时，`OMA_APPROVAL_TIMEOUT_MS` 可调），MCP 侧两层计时器都按 server 声明的 `timeoutMs` 走（`BACKEND_ASK_TIMEOUT_MS` 默认 24 小时），静默人类 fail-closed。仍缺：pending 事项在 Web 之外只有卡片一个消费面。

**子进程活着但沉默，run 与卡片都不知道。**（2026-09-25，两次真实 run。）适配器的读取器会在子进程退出后 5 秒内收尾（Bun `child.exited` + 孤儿管道宽限），所以「子进程死了不结算」并不成立——实测是**子进程还在、但数分钟零事件**：一条 run 是 `ask` 权限模式下启动后什么都没吐（连 `agent_start` 都没有），另一条停在子代理委派之后。此时卡片只有计时器在走，唯一兜底是 30 分钟墙钟看门狗，两条 run 都得手工取消才结算。两条可选修法（未选）：①dispatch 加「静默看门狗」——连续 N 分钟无事件且无 pending action 就停掉并以明确原因结算，风险是合法的长工具（一条跑十分钟的 bash）会被误杀；②让**子进程自己发心跳**（loop 每 N 秒一个无副作用的 status 事件），父侧与卡片据此区分「安静但活着」和「卡死」，代价是事件契约 + oma 循环各改一处。推荐 ②，因为 ① 的误杀是不可逆的。

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

**Lark Run 卡片第一期已落地**（ADR 0031：CardKit 直连流式投影、终态 canonical 封版、卡片「停止」按钮 + `/stop` 命令、重启恢复；终态可靠投递见 ADR 0032）。2026-09-24 追加：按钮回调经 lark-cli ≥1.0.9x 的 `card.action.trigger`，审批（批准/拒绝）与追问的选项按钮都已接（`answer_ask` 走 `/api/product-tools/ask/resolve`，与 Web 同一条路径）；卡片有过程视图（当前动作 + 已完成步骤 + todo 计划条）。同日第二批：**追问挂起时话题回复即答案**（`postMessage` 拦截，见「执行的可靠性」条）；**重启回读**（恢复卡在首帧前从 run 详情的 `pendingActions` 重建按钮，映射与活事件归约逐字段等价）；**回调去重与校验在位**（`reserveEventId` LRU 去重 + 全部 run 控制校验「卡片存在/chat 匹配/run 匹配」，测试钉住；operator 记录留痕）。仍欠：追问的**多选**提交、reaction 触发；签名 action token 维持 ADR 0031/0026 的延期决定（单用户部署，多操作者时再做）；**注意每应用卡片实体绑定配额**（200780，测试约 18 张触发）——高频使用需关注配额或提供 IM-patch 降级路径。

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

## 明确不做的

- omp `CustomTool` 的模块形状兼容（ArkType 三栖 schema 加 `CustomToolAPI` 工厂，等于移植半个 pi 运行时）。
- Claude 的 hooks.json 协议、commands、agents、LSP。
- jiti 之类的运行时转译：插件加载一律用 Bun 原生 `import()`。
