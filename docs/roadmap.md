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

**运行时的 `waiting` 状态不可达。** 唯一会写它的路径需要一个待响应事项的持久化记录，而那条路径没有生产调用方。真实的审批走 Run 级事件流加审批端点，Run 全程 `running`。要么把等待状态落到 Conversation 可见层（这样切设备也能看到待审批），要么把这个状态从枚举里去掉。

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

**产物缺内容账本与保留策略。** 来源信息有了（meta 文件加列表接口），缺 sha256 内容账本与校验端点、保留期的定时清理、以及主动清除接口。

**知识库只有文件级。** 没有 embedding 流水线、向量存储、chunk 级检索；统计里的 token 与 chunk 数是估算，没有重建索引和试查询端点。

**技能包的调用计数没有。** 设计里有「今日调用」这类统计，需要工具调用事件带上来源包 id。

## 安全

完整清单在 [安全与债务清单](./architecture/security/debt.md)，这里只列需要设计决策的那几条：

**bash 的网络白名单。** 现在只有「全断网」和「全开」两种，没有中间档；要放行特定的 registry 就得写策略。

**审批里的 `sandboxed` 信号没接线。** 字段存在但恒为 false，所以「已沙箱化的命令自动放行、未沙箱化的走审批」这条设计没有落地，bash 沙箱目前只能靠设置手动开。

**MCP 面的三件事。** stdio 的 CRUD 允许任意命令（等于 token 持有者就是宿主机 shell）、读取单个 server 时明文返回凭据、url server 挂载前没有 SSRF 检查。

**原生工具的细粒度权限。** 现在只有按工具名的高危清单与 auto 分类器，没有 allow-rules 那种按参数放行的机制。

**文件权限。** provider 密钥明文存在 SQLite 里，`dataDir`、`backend.db`、backend 的 `.env` 权限都是 0644。

**网络化部署的准入门槛**（离开回环地址之前必须做掉）：bash 网络白名单、MCP 凭据加密存储与 SSRF guard、移除 mock 登录表面、原生工具 allow-rules。

## 内容分发

**内置技能包与知识包只播种一次，之后不再刷新。** `seedSkillPacks` 发现 builtin 记录已存在就直接返回，所以 `skills/` 改了、删了、加新技能之后，老安装里那份拷贝永远停在原地——而它会被桥接进 Agent 工作区、注入到 prompt 里。实测后果：本机 `.backend-data/skill-packs/builtin/` 里至今躺着 `loop-engine`、`loop-workflow`、`skill-pack-installer` 三个已经删掉的技能，模型读到的就是这个过期心智模型；知识包那份同理，还残留着 `createAgentSession()`。

修法可以很省：`packages/source-fetch` 已经有 `directoryFingerprint`，启动时比一次指纹，不同就重拷（user 那份有自己的 keepSynced 机制，不受影响）。在此之前，升级后重装或删掉那个目录是唯一让它更新的办法。

## 界面

**Run 的跨度追踪只做了第一层。** 现在能从 `agent_run_event` 推出工具调用与模型轮次的瀑布图，没有传输层（spawn、管道、写库）的耗时。要加就得在适配器里埋点，而且必须保持「跨度是 Run 级遥测，不是第二个执行身份」——Phase 6 删掉旧 span 表就是为了防这个。

**Run 的中途暂停没有。** 现在只有停止。暂停需要子进程能在中途存状态并在恢复命令后接着跑，牵动 oma 的循环、适配器协议与输入队列语义。

## 明确不做的

- omp `CustomTool` 的模块形状兼容（ArkType 三栖 schema 加 `CustomToolAPI` 工厂，等于移植半个 pi 运行时）。
- Claude 的 hooks.json 协议、commands、agents、LSP。
- jiti 之类的运行时转译：插件加载一律用 Bun 原生 `import()`。
