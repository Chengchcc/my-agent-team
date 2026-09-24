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

**HITL 的持久化差最后一环：过期与 Lark 可见。** approval 与 ask 都已走 durable PendingAction v1（`approval_request`/`ask_question` 写 `pending_action` 表，run CAS `running→waiting`，回答与超时经 `consumePendingAction` 修复回 `running`）。仍缺：approval 没有超时语义（ask 有 60s 超时路径）、pending 事项对 Lark 端不可见（Run 卡片第三期的消费面）。

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

**飞书的会话绑定状态没有同步到后端。** Web 的对话页想显示「飞书已绑定」，但 `larkChatId ↔ conversationId` 的映射存在 lark-bot 自己的 SQLite 里，需要跨应用同步进后端。

**Lark Run 卡片第一期已落地**（ADR 0031：CardKit 直连流式投影、终态 canonical 封版、卡片「停止」按钮 + `/stop` 命令、重启恢复；终态可靠投递见 ADR 0032）。2026-09-24 追加：按钮回调经 lark-cli ≥1.0.9x 的 `card.action.trigger`，审批（批准/拒绝）与追问的选项按钮都已接（`answer_ask` 走 `/api/product-tools/ask/resolve`，与 Web 同一条路径）；卡片有过程视图（当前动作 + 已完成步骤 + todo 计划条）。仍欠：追问的自由文本输入（Card JSON 2.0 `input`/`form`）与多选、reaction 触发、多操作者的签名 action token 与 backend 侧 event_id 去重、lark-bot 重启后从 `pending_action` 回读未答的追问；**注意每应用卡片实体绑定配额**（200780，测试约 18 张触发）——高频使用需关注配额或提供 IM-patch 降级路径。

**产物缺内容账本与保留策略。** 来源信息有了（meta 文件加列表接口），缺 sha256 内容账本与校验端点、保留期的定时清理、以及主动清除接口。

**知识库只有文件级。** 没有 embedding 流水线、向量存储、chunk 级检索；统计里的 token 与 chunk 数是估算，没有重建索引和试查询端点。

**技能包的调用计数没有。** 设计里有「今日调用」这类统计，需要工具调用事件带上来源包 id。

**配置期的 `(backendKind, model)` 一致性校验已补（2026-09-24）。** `POST/PATCH /api/agents` 现在会把 `provider/model`（经 `MODEL_ALIASES` 归一）对照目标种类的目录，目录里没有就 400（`model-check.ts`；目录列不出来时降级为放行，配置不依赖子进程活着）。PATCH 只换 `backendKind` 时也会用旧模型对新目录查一次——这是当初真机翻车的那条路（`oma + deepseek/deepseek-chat` → 200，run 阶段才死）。

**omp 的静态模型表与它实际接受的 id 不一致。** `packages/adapter-omp-agent/src/model-catalog.ts` 是写死的表（omp 无枚举命令），其中 `deepseek-chat`/`deepseek-reasoner` 实测被 omp 拒绝（`--model` → 启动即 fatal `No API key found for openrouter`，因为回落到默认 provider）；且 `available: true` 是硬编码，无法反映 provider 有没有 key。oma 侧的同类问题已由一次产品 Run 修掉（`rpc-mode` 的 `validateExecute` 改用 `resolveModelEntry`）。

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
