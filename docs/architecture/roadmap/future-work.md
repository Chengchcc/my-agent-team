---
id: roadmap.future-work
title: 未来工作
status: future
owners: architecture
last_verified_against_code: 2026-07-01
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
- **端去重的统一化**　飞书侧的 `canSkipFinalLedgerText` 解决了终稿重发与首投必发的张力。若未来接入更多端，可考虑把「端去重」抽象成各适配器共享的一层，而非每个端各写一套。依赖：[飞书适配器](../surfaces/lark-adapter.md)。
- **恢复语义的强化**　checkpointer 的 saveInterrupt / consumeInterrupt 已支撑中断恢复。可进一步明确多次中断、反思分叉（`reflect:<threadId>`）与主线恢复之间的交互边界。依赖：[Framework 运行循环](../runtime/framework.md)、[后端总览](../backend/overview.md)。
- **Issue 协作工作流演进**　[Issue](../foundations/issue.md) 本体与 [Orchestrator](../backend/orchestrator.md) 固定线性推进已落地，下一版要把它演进成「可发起、按配置驱动、交付物可结构化传递、可验收返工、可观测」的协作流。完整设计抽象与不变量收拢在 [Issue 协作工作流](../foundations/issue-workflow.md)（`status: design`）；本节只记**落地顺序**。依赖：[Issue 协作工作流](../foundations/issue-workflow.md)、[Orchestrator](../backend/orchestrator.md)。

  里程碑切法（前置依赖优先，从 M18.3 起算）：

  | 里程碑 | 内容 | 为什么排这个位置 |
  |---|---|---|
  | **M18.3　Project 实体化** | 把 `project_id` 从裸字符串升级成真实受管实体（Project 表 + CRUD + git 仓库归属配置）；创建 Issue 改为**从已有 Project 中选**。 | **Issue 创建的前置**：`createIssue` 必填 `projectId`，且新版创建 UX 是「选 Project」而非「填字符串」。Project 不先成为受管实体，后面的创建改造无处落脚。这一棒排在最前。 |
  | **M18.4　列可配置 + threadId 派生 + 草稿态 + 看板拖拽/实时** | Orchestrator 转移从常量改为读 DB 配置（列绑定真实 Agent + prompt 模板，消除 `getById("planner")` 断裂）；`threadId` 由 `issueId` 派生不再人填；创建落草稿态、人工入列才启动；看板卡片可拖拽改 `status`（乐观更新 + 失败回弹）、状态变更经 SSE 实时回灌。 | Project 已可选后，才谈得上「为这个 Project 的列配执行者」；建即跑→草稿态是创建语义的改造，依赖 Project 选择就位。**原独立 M18.3 看板拖拽/SSE 实时 spec 并入此棒**——它原建立在裸输入/建即跑前提上，与本设计的草稿态/派生 threadId 冲突，须一并重做。 |
  | **M18.5　交付物结构化 + 上下文累积** | `submitDeliverable` 工具 + 交付物指针化落库；Issue 上下文（创建信息 + 历棒交付物）驱动 `renderPrompt`，支持 `{{deliverables.x.y}}` 提取。 | 列可配置（M18.4）让每棒有了执行者，这一步才让「上一棒喂下一棒」从扫文本升级为结构化传递。 |
  | **M18.6　人工验收闸门 + 返工** | `in_review` 加人工裁决；转移表线性→带回退边的图（`in_review → in_progress` 携反馈）。 | 交付物可结构化传递后（M18.5），人才有可验收的对象；返工回路依赖上下文累积承载打回反馈。 |
  | **M18.7　Issue Timeline + Issue 级可观测** | Issue Timeline 追加式工作事件流；补 `getRunOriginsByIssueId` 反查 + 前端详情抽屉，复用 M16 经 `run_origin.issue_id`。 | 横切观测面，依赖前面各步产生的工作事件，最后统一收口。 |

  > 关于编号从 M18.3 重起：曾有一版独立的「M18.3 看板拖拽与实时增量」spec，建立在「裸 Project/Thread 字符串输入 + 建即跑 + 纯线性转移」的旧前提上。本设计推翻了这些前提（Project 实体化、threadId 派生、草稿态、列可配置、带回退边的转移图），故该 spec 不再独立成棒，其拖拽与 SSE 实时部分并入 M18.4 一并重做；里程碑编号自 M18.3 重新起算。

  原则：每个里程碑落地时，同步回填它所触及的 `status: current` 页（[Issue](../foundations/issue.md)、[Orchestrator](../backend/orchestrator.md)、[Issue 生命周期端到端](../flows/e2e-issue-lifecycle.md)），并把对应小节从 [Issue 协作工作流](../foundations/issue-workflow.md) 的 `design` 状态推进为现状。
- **@提及收编进编排**　现状里 @提及自动触发（`onRunComplete` 扫描文本 → `forkAgentRuns`）和 Orchestrator 的状态机推进是两套驱动。未来可把对话内的 @提及招呼也统一交给编排器调度，让「下一步谁干」只有一个权威来源。依赖：[Orchestrator](../backend/orchestrator.md)、[对话与成员](../conversation/conversation-and-members.md)。
- **Loop Engineering（统一工作系统）**　现有 Issue/CronJob 覆盖了 loop 五动作里的交接、持久化、半个调度，但两个概念各管一半、都不表达「按调度自动发现工作 + 多步流水线推进 + 跨轮状态持久」。Loop 把它们统一成一个**文件态**工作系统：配置在 `.loop/` 文件、item 状态在 STATE.md、CronJob 退成调度者、`loopStep()` 无状态推进。**Goal 是创建对话框里的过渡态，翻译成 config 后消失，验收标准沉淀为 config.yml 的 `acceptance` 字段——不新增 Goal/Step/Edge 数据库实体**。完整设计与不变量收拢在 [Loop Engineering](../foundations/loop-engineering.md)（第一性原理入口）、[Loop](../foundations/loop.md)、[LoopRunner](../backend/loop-runner.md)、[Loop Pattern](../foundations/loop-pattern.md)、[Loop 验证端到端](../flows/e2e-loop-verification.md)；本节只记**落地顺序**。核心判断：这是**最小 DB 改动**（唯一加 `cron_job.loop_config_path` 一列）+ 文件态本体，不是 schema 大重构；MVP 是**入口统一、数据未统一**——`/issues` 移除、Issue 表只读**不迁移**（迁移列入 Phase 3）。落地顺序、并发一致性、预算等硬约束以 [PRD](../../prd/loop-engineering.md) 为准。依赖：[Loop Engineering](../foundations/loop-engineering.md)、[定时任务](../foundations/cron-job.md)、[AgentSession](../harness/harness.md)、[Orchestrator](../backend/orchestrator.md)、[文件型记忆插件](../plugins/fs-memory.md)。

  里程碑切法（对齐 [PRD](../../prd/loop-engineering.md) §8 的 Phase 1/2/3；**检查先于并行**——验证第一，并行最后）：

  | Phase | 内容 | 为什么排这个位置 |
  |---|---|---|
  | **Phase 1（MVP）　文件态本体 + 单 Loop 编排** | `loopReducer()` 纯函数 + 测试；`loopStep()` 无状态编排（discovery → generator → evaluator → human gate，STATE.md 持久）；`.loop/` 目录结构 + STATE.md 读写；CronJob 加 `loop_config_path` 列 + handler 集成；Loop CRUD API + 自然语言创建对话框（intent→config 翻译 + 预览 + scaffold）；Web 仪表盘 + 详情页 review queue；预算保护 + denylist 强制执行。**同棒硬约束**：per-loop 写锁（三入口共用，不能只靠 CronJob 单飞锁）、原子预算计数（不落 STATE.md）、`maxParallelFindings` + 进程级 AgentSession 池（**当前不存在，须新建**）。 | 地基：把「配置在文件、状态在 STATE.md、Goal 是过渡态」这套文件态本体立起来，最小 DB 改动。所有后续能力依赖它。验证（独立 Evaluator + acceptance 靶子）在 MVP 就一等落地，因为治点头回路是整套设计的核心动机。 |
  | **Phase 2　增强体验** | SSE 实时进度推送（Loop 运行时间线）；Evaluator 通过 MCP 操作浏览器（截图验证前端改动）；Post-run critique 展示和编辑；手动 item 添加 UI；多 Loop 仪表盘性能优化（分页、缓存）。 | 单 Loop 编排跑通后，才谈得上把验证从「跑测试」扩到「操作浏览器」、把进度实时化。不改本体，只加体验与验证广度。 |
  | **Phase 3　高级能力 + 数据收敛** | Loop 之间 item 移动（promote）；**已有 Issue 数据迁移工具**（把 MVP 遗留的只读 Issue 表收敛进 Loop，真正做到单一数据源）；Loop Ready Score 展示；多 Loop 协调与去重。 | 迁移刻意排最后：MVP 先用「入口统一、数据并存」把 Loop 立稳、验证文件态模型跑得通，再动风险最大的 Issue→STATE.md 数据迁移。并行/多 Loop 协调也在此档，守「检查先于并行」。 |

  > 排序铁律「检查先于并行」来自 Loop Engineering 概念本身：在验证被证明可靠之前绝不加并发。多 Loop 协调 / 并行是这条线的**最后**一步——先把单条回路的文件态本体、独立验证、断路、发现跑通。

  > **Phase 1/2/3 是实现顺序，不是自主度**：这三档说的是「按什么顺序把这套本体建出来」。一条**已经建好**的 loop 还有另一条正交的放权轴——L1 报告 → L2 辅助 → L3 无人值守（每档等上一档证明价值后再放开，创建默认 L1），详见 [Loop Engineering](../foundations/loop-engineering.md) 的「运营成熟度」与 [Loop Pattern](../foundations/loop-pattern.md) 的信任层级。别把「Phase 实现顺序」和「L 自主度」两条轴混为一谈。

  原则：每个 Phase 落地时，同步回填它所触及的 `status: current` 页（[Issue](../foundations/issue.md)、[Orchestrator](../backend/orchestrator.md)、[CronJob](../foundations/cron-job.md)），并把 [Loop](../foundations/loop.md)、[LoopRunner](../backend/loop-runner.md)、[Loop Engineering](../foundations/loop-engineering.md) 对应小节从 `design` 推进为现状。
- **Ops 导航转 session / trace 中心**　现状 Ops 面以 run 为中心列举（run 列表 → run 详情），词汇与分区都停在 daemon 时代的 `run`。[标识符体系](../foundations/identifiers.md) 把本体收敛为「session（一条 trace）→ span（root span）→ attempt（重试序号）」后，Ops 导航也应顺着这条链改：顶层按 **session** 聚合（一个 agent 在一个上下文里的整条记忆线），点进去看这条线上的 **span 序列**（每次 prompt loop 一段，按 spanId 切的 `checkpoint_events` 即其执行事实流），再下钻到 **attempt / child span**。这让「这条线到底跑过几轮、第 3 轮前是什么状态」成为一次自然的层层下钻，而不是在扁平 run 列表里靠 `idempotencyKey` 反推。依赖：[标识符体系](../foundations/identifiers.md)、[数据模型](../backend/data-model.md)。
- **删除 transport / heartbeat 残骸**　`pid` / `heartbeat_at`（`attempt` 表）和心跳 reaper 是 runner daemon 时代的产物：跨进程执行需要一个进程外存活信号，backend 靠扫心跳判断 daemon 是否卡死。AgentSession 改为进程内执行后，这个前提消失——进程内执行要么在跑、要么随进程一起没了，没有「独立进程失联」这种中间态需要心跳来探。这两列已标 `deprecated`，未来应连同 reaper 的心跳分支一并删除，超时统一由 per-span 看门狗（主动 cancel）表达，不再保留 daemon 式的被动心跳兜底。依赖：[数据模型](../backend/data-model.md)、[标识符体系](../foundations/identifiers.md)。
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
