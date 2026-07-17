---
id: roadmap.future-work
title: 未来工作
status: future
owners: architecture
last_verified_against_code: 2026-07-01
summary: "这一页是唯一谈「还没做 / 想做」的地方——刻意和描述当前状态的所有页面隔离开，避免把「现状」和「设想」混在一起误导读者。其余每一页都只讲代码现在确实是怎样的；任何前瞻性的方向都收拢到这里，并标注它依赖哪些现有抽象。"
depends_on:
  - backend.conversation-projection
  - surfaces.lark-adapter
  - runtime.framework
  - backend.orchestrator
  - foundations.issue
  - foundations.issue-workflow
used_by:
---

# 未来工作

这一页是唯一谈「还没做 / 想做」的地方——刻意和描述当前状态的所有页面隔离开，避免把「现状」和「设想」混在一起误导读者。其余每一页都只讲代码现在确实是怎样的；任何前瞻性的方向都收拢到这里，并标注它依赖哪些现有抽象。

## 为什么单独成页

整套文档遵循「现状优先」：每一页描述的都是代码此刻真实的样子，可被 `last_verified_against_code` 核对。如果在正文里夹杂「将来会改成 X」，读者很难分清哪句是现在、哪句是设想。所以所有前瞻内容统一放这里，正文保持纯粹。

## 方向（与现有抽象的关系）

> 以下为方向性条目，不代表已实现；落地前请以对应当前状态页为准。

- **更细的投影可见性策略**　当前 assistant 消息经 `onRunMessage` 直写账本，projection bridge只做 best-effort fan-out。未来可引入更细的可见性规则（按成员、按事件子类型），但任何扩展都应保持「assistant 消息与人类消息同一入口直写账本」「账本为唯一对话事实」这两条不变式。依赖：[会话投影](../backend/conversation-projection.md)、[事实与投影](../foundations/facts-and-projections.md)。
- **端去重的统一化**　**已解决。** 飞书侧的 `canSkipFinalLedgerText` 及相关 dedup 逻辑已随 Lark 重构移除，SSE 事件直接渲染。当前仅 Web + Lark 两端，各自无去重负担。若未来接入更多端再考虑共享去重层。
- **恢复语义的强化**　checkpointer 的 saveInterrupt / consumeInterrupt 已支撑中断恢复。可进一步明确多次中断、反思分叉（`reflect:<threadId>`）与主线恢复之间的交互边界。依赖：[Framework 运行循环](../runtime/framework.md)、[后端总览](../backend/overview.md)。
- **Issue 协作工作流演进**　**已被 Loop Engineering 取代。** Issue 本体与 Orchestrator 模块已删除（无 `features/orchestrator/`、无 Issue CRUD），工作流编排能力由 Loop 系统承接（Generator -> Evaluator -> Human Gate）。M18.3-M18.7 里程碑失效，Project 实体化已独立落地（`features/project/` CRUD 已完成）。`span_origin.issueId` 字段为历史残留。
- **@提及收编进编排**　**已解决。** Orchestrator 已删除，@提及自动触发（`conversation/service.ts` 的 `#forkAgentRuns`）是唯一驱动来源。两套驱动的问题不存在了。
- **Loop Engineering（统一工作系统，把半个回路补成完整回路）**　现有 Issue/CronJob 覆盖了 loop 五动作里的交接、持久化、半个调度，但两个概念各管一半、都不表达「按调度自动发现工作 + 多步流水线推进 + 跨轮状态持久」。Loop 把它们统一成一个**文件态**工作系统：配置在 `.loop/` 文件、item 状态在 STATE.md、CronJob 退成调度者、`loopStep()` 无状态推进。**Goal 是创建对话框里的过渡态，翻译成 config 后消失，验收标准沉淀为 config.yml 的 `acceptance` 字段——不新增 Goal/Step/Edge 数据库实体**。完整设计与不变量收拢在 [Loop Engineering](../foundations/loop-engineering.md)（第一性原理入口）、[Loop](../foundations/loop.md)、[LoopRunner](../backend/loop-runner.md)、[Loop Pattern](../foundations/loop-pattern.md)、[Loop 验证端到端](../flows/e2e-loop-verification.md)；本节只记**落地顺序**。核心判断：这是**最小 DB 改动**（唯一加 `cron_job.loop_config_path` 一列）+ 文件态本体，不是 schema 大重构；MVP 是**入口统一、数据未统一**——`/issues` 移除、Issue 表只读**不迁移**（迁移列入 Phase 3）。落地顺序、并发一致性、预算等硬约束以 [PRD](../../prd/loop-engineering.md) 为准。依赖：[Loop Engineering](../foundations/loop-engineering.md)、[定时任务](../foundations/cron-job.md)、[AgentSession](../harness/harness.md)、[Orchestrator](../backend/orchestrator.md)、[文件型记忆插件](../plugins/fs-memory.md)。

  里程碑切法（对齐 [PRD](../../prd/loop-engineering.md) §8 的 Phase 1/2/3；**检查先于并行**——验证第一，并行最后）：

  | Phase | 内容 | 为什么排这个位置 |
  |---|---|---|
  | **Phase 1（MVP）　文件态本体 + 单 Loop 编排** | `loopReducer()` 纯函数 + 测试；`loopStep()` 无状态编排（discovery → generator → evaluator → human gate，STATE.md 持久）；`.loop/` 目录结构 + STATE.md 读写；CronJob 加 `loop_config_path` 列 + handler 集成；Loop CRUD API + 自然语言创建对话框（intent→config 翻译 + 预览 + scaffold）；Web 仪表盘 + 详情页 review queue；预算保护 + denylist 强制执行。**同棒硬约束**：per-loop 写锁（三入口共用，不能只靠 CronJob 单飞锁）、原子预算计数（不落 STATE.md）、`maxParallelFindings` + 进程级 AgentSession 池（**当前不存在，须新建**）。 | 地基：把「配置在文件、状态在 STATE.md、Goal 是过渡态」这套文件态本体立起来，最小 DB 改动。所有后续能力依赖它。验证（独立 Evaluator + acceptance 靶子）在 MVP 就一等落地，因为治点头回路是整套设计的核心动机。 |
  | **Phase 2　增强体验** | SSE 实时进度推送（Loop 运行时间线）；Evaluator 通过 MCP 操作浏览器（截图验证前端改动）；Post-run critique 展示和编辑；手动 item 添加 UI；多 Loop 仪表盘性能优化（分页、缓存）。 | 单 Loop 编排跑通后，才谈得上把验证从「跑测试」扩到「操作浏览器」、把进度实时化。不改本体，只加体验与验证广度。 |
  | **Phase 3　高级能力 + 数据收敛** | Loop 之间 item 移动（promote）；**已有 Issue 数据迁移工具**（把 MVP 遗留的只读 Issue 表收敛进 Loop，真正做到单一数据源）；Loop Ready Score 展示；多 Loop 协调与去重。 | 迁移刻意排最后：MVP 先用「入口统一、数据并存」把 Loop 立稳、验证文件态模型跑得通，再动风险最大的 Issue→STATE.md 数据迁移。并行/多 Loop 协调也在此档，守「检查先于并行」。 |

  > 排序铁律「检查先于并行」来自 Loop Engineering 概念本身：在验证被证明可靠之前绝不加并发。多 Loop 协调 / 并行是这条线的**最后**一步——先把单条回路的文件态本体、独立验证、断路、发现跑通。

  > **Phase 1/2/3 是实现顺序，不是自主度**：这三档说的是「按什么顺序把这套本体建出来」。一条**已经建好**的 loop 还有另一条正交的放权轴——L1 报告 → L2 辅助 → L3 无人值守（每档等上一档证明价值后再放开，创建默认 L1），详见 [Loop Engineering](../foundations/loop-engineering.md) 的「运营成熟度」与 [Loop Pattern](../foundations/loop-pattern.md) 的信任层级。别把「Phase 实现顺序」和「L 自主度」两条轴混为一谈。

  原则：每个 Phase 落地时，同步回填它所触及的 `status: current` 页（[Issue](../foundations/issue.md)、[Orchestrator](../backend/orchestrator.md)、[CronJob](../foundations/cron-job.md)），并把 [Loop](../foundations/loop.md)、[LoopRunner](../backend/loop-runner.md)、[Loop Engineering](../foundations/loop-engineering.md) 对应小节从 `design` 推进为现状。
- **产品力审查发现（2026-07-13）**　从业务故事线（在场协作 / 离场托付 / 系统管理）出发的全面审查，识别出以下产品缺口。**大部分已于 2026-07-14 修复**，标注 ✅ 已完成 / ⏳ 待办。

  | 优先级 | 缺口 | 故事线 | 状态 | 修复内容 |
  |---|---|---|---|---|
  | **P0** | Goal state 持久化 | 离场托付 | ✅ 已完成 | `goal-state.ts` 改为 `createGoalStateStore(settingsSvc)`，condition+paused 持久化到 settings KV 表 |
  | **P0** | Cron Job 管理页缺失 | 系统管理 | ✅ 已完成 | System 页加 Cron Jobs tab，复用已有 CronJobForm + hooks |
  | **P1** | Session 浏览器 | 系统管理 | ✅ 已完成 | System 页加 Sessions tab，复用 `useOpsSessions` |
  | **P1** | Run detail 从 System 可达 | 系统管理 | ✅ 已完成 | RunOpsTable 行可点击 -> `/system/runs/[runId]` 独立详情页 |
  | **P1** | Lark 绑定流程断裂 | 双端同步 | ✅ 已完成 | AgentForm 创建模式显示提示，保存后跳转编辑页做 setup |
  | **P1** | MCP 连接状态不回填 | 系统管理 | ✅ 审计误报 | service.ts 已填充 status/toolsCount，McpServerPanel 已显示 |
  | **P2** | Loop 不可暂停 | 离场托付 | ✅ 已完成 | `POST /api/loops/:id/deactivate` + `useDeactivateLoop` hook + UI toggle |
  | **P2** | Loop 预算历史无 API | 离场托付 | ✅ 审计误报 | 已通过 `GET /api/loops/:id` 返回，detail 页已渲染 |
  | **P2** | Stop 按钮不直观 | 在场协作 | ✅ 已完成 | ConversationCanvas busy 状态显示 Stop 按钮 |
  | **P2** | Goal 不可视化 | 在场协作 | ✅ 已完成 | ConversationCanvas 加 GoalStatusBar，显示条件/轮次/暂停/恢复/清除 |
  | **P2** | System 页 Traces tab 误导 | 系统管理 | ✅ 已完成 | tab 改名为 "Runs"（诚实命名），行可点击进入 `/system/runs/[runId]` |
- **Solo 项目借鉴（2026-07-14）**　分析了 [solo-agent/solo](https://github.com/solo-agent/solo) 的关键子系统，以下 4 项设计值得借鉴，按实现难度排序：

  | 优先级 | 功能 | Solo 设计 | 我们现状 | 成本 |
  |---|---|---|---|---|
  | **P0** | 连接状态指示器 | `network-status.tsx` 65 行：`navigator.onLine` + online/offline 事件 + 顶部 banner（offline 红色 / 恢复绿色 3s 后隐藏） | `streamConn` 状态已有但零 UI 反馈，SSE 断了用户看到冻结画面无感知 | 1 小时 |
  | **P1** | Agent 关系图 + Wake Routing | 两种关系 `assigns_to`/`collaborates_with`（带 weight + instruction）；关系变更自动生成 `RELATIONSHIPS.md` 写入 agent workspace；coordinator 选择 ~20 行算法（遍历关系图找无 parent 的根节点）；wake routing ~55 行（有 @mention 只唤醒被提及的；无 @mention 自动选 coordinator） | agent 之间扁平，靠用户手动 @mention 路由，无 coordinator 概念 | 3 天 |
  | **P1** | Task 看板 + Claim Window | 5 状态 `todo→in_progress→in_review→done/closed`，严格转换矩阵；claim 窗口 ~155 行纯内存（@mention 的 agent 有 30s 独占认领权，超时放给其他 agent）；actor 权限（agent 不能 close/reopen，只有 creator 能 accept）；agent 旁路 `CompleteTaskForAgent` 跳过 guard 自动提交 review | Loop `ItemState` 已有 priority/step/awaiting_review，数据模型在但缺 UI 看板层 | 3-5 天 |
  | **P2** | CMD+K 全局搜索 | 337 行：全屏 overlay + 300ms 防抖 + 键盘导航（ArrowUp/Down/Enter/Escape）+ `<mark>` 高亮 + 点击跳转消息位置 | 有 `/api/conversations/search` 但只在 chat 页用，无全局快捷入口 | 2-3 天 |

  Solo 的设计亮点模式（实现时参考）：
  - **URL as state**：面板/视图/task/thread 状态编码到 URL searchParams，可分享、可前进后退
  - **双 hook 模式**：`useInbox`（分页列表）+ `useInboxUnread`（轻量计数）分开，badge 频繁轮询不拉全量数据
  - **乐观更新+回退**：markRead 先本地标记，API 失败 refetch 回退，比 mutation onSuccess 更快
  - **Flash highlight**：选中 agent 后 1.5s 高亮消失，平滑引导注意力

  不值得借鉴的：daemon/computer 管理（架构不兼容）、WebSocket hub（SSE 够用）、artifact HTML 生成（过重）、channel team graph ReactFlow（130KB 依赖，文本 RELATIONSHIPS.md 足够）、thread panel（940 行，扁平对话够用）。
- **Pi 架构借鉴（2026-07-17）**　分析了 [earendil-works/pi](https://github.com/earendil-works/pi) 的核心架构设计，以下按优先级记录值得借鉴的技术架构点：

  | 优先级 | 设计 | Pi 做法 | 我们现状 | 成本 |
  |---|---|---|---|---|
  | **P0** | Provider 注册制 | `Provider` 接口（id/auth/models/stream）+ `Models` 注册表（setProvider/deleteProvider/getModel），provider 在启动时注册一次全局复用，stream 按 `model.provider` 分派 | `createModel()` 硬编码 `new AnthropicChatModel`，每次调用都 new SDK client，只支持 Anthropic | 2-3 天 |
  | **P0** | Model 对象替代裸字符串 | `Model<TApi>` 有 provider/id/api/baseUrl，agent config 存 `{provider, id}` 而非裸 `modelName: "claude-sonnet-4"` | `agent.modelName` 是字符串，不校验是否存在，不关联 provider | 1 天（依赖 P0 Provider） |
  | **P1** | Hook 事件返回类型 | `AgentHarnessEventResultMap` 每个 hook 有明确返回类型，`beforeProviderRequest` 可 per-call 改 headers/timeout/retries | `PluginHooks` 返回值简单，无 `beforeProviderRequest` hook，无法 per-call 注入 headers | 2 天 |
  | **P1** | AgentMessage declaration merging | `CustomAgentMessages` 空接口，app 通过 declaration merging 加自定义消息类型，`AgentMessage = Message \| CustomAgentMessages[keyof]` | `Message` 是固定 union，加新类型要改 `@my-agent-team/message` 包 | 半天 |
  | **P2** | ExecutionEnv 抽象 | `FileSystem` + `Shell` 接口 + 稳定错误码（FileErrorCode/ExecutionErrorCode），可注入不同实现（node:fs/sandbox/浏览器） | 工具直接用 `node:fs` 和 `Bun.spawn`，硬编码 | 3-5 天 |
  | **P2** | Session Tree | Session 是树结构（非线性数组），每条 entry 有 id+parentId，支持 fork/回溯/中途换模型/压缩点保留可逆 | `Thread.messages` 线性数组，checkpointer 只做 save/load | 极高（架构级重设计） |
  | **P2** | Compaction 可逆 | `CompactionEntry` + `BranchSummaryEntry`，压缩在树里打节点保留分支摘要，可回溯到压缩前 | `summarizingContextManager` 直接替换旧消息，不可逆 | 高（依赖 Session Tree） |
  | **P3** | Result<T,E> 错误类型 | `Result<TValue, TError>` 显式 `{ok, value} \| {ok: false, error}`，不依赖 throw | 全用 throw + try/catch + DomainError 层级 | 低（风格偏好，不值得迁移） |
  | **P3** | Tool terminate 标记 | `AgentToolResult.terminate: boolean`，工具可标记"执行后终止 agent loop" | 无，工具不能主动终止 loop（InterruptSignal 已覆盖类似场景） | 低 |

  Pi 的 Provider 设计是最高价值借鉴点。当前 `createModel` 硬编码 Anthropic 是多 provider 支持的根本障碍。Pi 的 `createProvider` 工厂 + `Models` 注册表模式可以：
  1. 启动时注册 provider（anthropic/openai/custom），全局复用 SDK client
  2. agent 配置存 `{provider, id}` 替代裸字符串
  3. `Models.stream(model, context)` 按 provider 分派，auth 在请求时解析
  4. 未来加新 provider 只需 `setProvider(newProvider)`，不改框架代码

  不值得借鉴的：OAuth（桌面端场景）、动态 model 列表拉取（可后加）、TypeBox 类型（我们用 zod 已够用）。
- **Ops 导航转 session / trace 中心**　现状 Ops 面以 run 为中心列举（run 列表 → run 详情），词汇与分区都停在 daemon 时代的 `run`。[标识符体系](../foundations/identifiers.md) 把本体收敛为「session（一条 trace）→ span（root span）→ attempt（重试序号）」后，Ops 导航也应顺着这条链改：顶层按 **session** 聚合（一个 agent 在一个上下文里的整条记忆线），点进去看这条线上的 **span 序列**（每次 prompt loop 一段，按 spanId 切的 `checkpoint_events` 即其执行事实流），再下钻到 **attempt / child span**。这让「这条线到底跑过几轮、第 3 轮前是什么状态」成为一次自然的层层下钻，而不是在扁平 run 列表里靠 `idempotencyKey` 反推。依赖：[标识符体系](../foundations/identifiers.md)、[数据模型](../backend/data-model.md)。
- **删除 transport / heartbeat 残骸**　**已解决。** `attempt` 表的 `pid` / `heartbeat_at` 列已删除（migration 0009），reaper 心跳分支已移除，超时由 per-span 看门狗（主动 cancel）表达。
- **Harness 运行时加固（M22）**　**已落地。** 四项子任务全部完成，相关 `status: current` 页面已回填：

  | 子项 | 结果 | 回填页面 |
  |---|---|---|
  | **上下文压缩转默认** | shape/beforeModel 顺序反转（先注入再整形，预算不再「瞎」）；Harness 默认 `pipeContextManagers(toolResultTruncator, summarizingContextManager{structuredSummarize})`；引入 `structuredSummarize` 结构化摘要器。 | [上下文管理器](../runtime/context-manager.md) |
  | **回合内工具并行** | 工具声明 `executionMode: "concurrent"`，同回合并发执行；串行/并行混跑，`tool_result` 按原始顺序插入保证消息合法。 | [Framework 运行循环](../runtime/framework.md) |
  | **运行中插话（steering / follow-up）** | 引入 SteeringQueue（每步排出干预消息）+ FollowUpQueue（外层跟进循环），长任务中途可纠偏/补充而无需打断重启。 | [Framework 运行循环](../runtime/framework.md) |
  | **Skill 双域 + 显式调用** | 双域发现（global + project 双 roots，project 同名覆盖 global）；`/skill:name` 显式调用；`disableModelInvocation` 关闭模型自动触发。 | [渐进式技能](../plugins/progressive-skill.md) |

## 处理原则

这个项目对技术债的态度是**及时彻底修复，没有任何项目内容不可改动**。因此这一页不是「攒着不还的债务清单」，而是「明确标注、择机推进、改动时一并到位」的方向记录。任何一项推进时，都应连带更新它所依赖页面的当前状态描述，使文档持续与代码对齐。

## 关联页面

- [架构 Wiki 首页](../README.md)
- [事实与投影](../foundations/facts-and-projections.md)
