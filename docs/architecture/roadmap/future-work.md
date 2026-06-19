---
id: roadmap.future-work
title: 未来工作
status: future
owners: architecture
last_verified_against_code: 2026-06-16
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

- **更细的投影可见性策略**　当前 assistant 消息经 `onRunMessage` 直写账本，投影桥只做 best-effort 扇出。未来可引入更细的可见性规则（按成员、按事件子类型），但任何扩展都应保持「assistant 消息与人类消息同一入口直写账本」「账本为唯一对话事实」这两条不变式。依赖：[会话投影](../backend/conversation-projection.md)、[事实与投影](../foundations/facts-and-projections.md)。
- **端去重的统一化**　飞书侧的 `canSkipFinalLedgerText` 解决了终稿重发与首投必发的张力。若未来接入更多端，可考虑把「端去重」抽象成各适配器共享的一层，而非每个端各写一套。依赖：[飞书适配器](../surfaces/lark-adapter.md)。
- **恢复语义的强化**　checkpointer 的 saveInterrupt / consumeInterrupt 已支撑中断恢复。可进一步明确多次中断、反思分叉（`reflect:<threadId>`）与主线恢复之间的交互边界。依赖：[Framework 运行循环](../runtime/framework.md)、[常驻 Runner](../runner/resident-runner.md)。
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

## 处理原则

这个项目对技术债的态度是**及时彻底修复，没有任何项目内容不可改动**。因此这一页不是「攒着不还的债务清单」，而是「明确标注、择机推进、改动时一并到位」的方向记录。任何一项推进时，都应连带更新它所依赖页面的当前状态描述，使文档持续与代码对齐。

## 关联页面

- [架构 Wiki 首页](../README.md)
- [事实与投影](../foundations/facts-and-projections.md)
