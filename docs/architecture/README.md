# 架构

现状区。本目录每一页都描述代码**此刻**的样子，页内的每一条事实都能落到具体文件上；改了代码不改页，页就是错的。

## 范围

覆盖：系统全貌与所有权划分、数据与历史、执行链（Run 与四个 Agent Backend）、自研 runtime、Workflow 编排、各端消息路径、安全边界与已知欠债、以及三条写代码前必读的规则（设计哲学、跨进程契约、DB 类型链）。

不覆盖：还没做的事在 [`../roadmap.md`](../roadmap.md)；每个决策的来龙去脉在 [`../adr/`](../adr/README.md)；安装、运行与排障在仓库根 [`README.md`](../../README.md) 和 [`../guides/`](../guides/)。历史设计推演（spec/plan/retro）已经删除，git 记录里还有。

## 按任务找页

| 要做的事 | 按顺序读 |
|---|---|
| 看懂整体 | [系统总览](./system-overview.md) → [Workflow](./workflow.md) → [事实与投影](./foundations/facts-and-projections.md) → [Product Backend](./backend/overview.md) |
| 改消息与历史 | [事实与投影](./foundations/facts-and-projections.md) → [Conversation History](./conversation/history.md) → [Agent Context](./agents/context.md) → [数据模型](./backend/data-model.md) |
| 改执行链或后端适配 | [Agent Backend](./execution/agent-backend.md) → [Agent Context](./agents/context.md) → [Product Backend](./backend/overview.md) → [Oma Runtime](./runtime/oma.md) |
| 改实时更新与终态提交 | [Run 输出与实时更新](./runs/output-and-live-updates.md) → [Conversation History](./conversation/history.md) → [Agent Context](./agents/context.md) → [Web 消息端到端](./flows/e2e-web-message.md) |
| 改工具、MCP 或插件 | [Agent Backend](./execution/agent-backend.md) → [Oma Tools](./runtime/oma-tools.md) → [Oma 插件与 HITL](./plugins/oma-plugins.md) |
| 改模型与 provider | [模型与 Provider](./runtime/models.md) → [Oma Runtime](./runtime/oma.md) |
| 改 Workflow 或 Project | [Agentic Workflow](./workflow.md) → [数据模型](./backend/data-model.md) → [Project 与 Worktree](./agents/projects-and-worktrees.md) |
| 改 Web 端 | [Web 消息端到端](./flows/e2e-web-message.md) → [Web 端](./surfaces/web.md) → [端总览](./surfaces/overview.md) |
| 改飞书端 | [飞书](./surfaces/lark.md) → [飞书消息端到端](./flows/e2e-lark-message.md) → [Conversation History](./conversation/history.md) |
| 改自研 runtime | [Oma Runtime](./runtime/oma.md) → [Oma 插件与 HITL](./plugins/oma-plugins.md) → [Compaction](./runtime/compaction.md) → [Oma Tools](./runtime/oma-tools.md) |
| 查安全边界与欠债 | [安全模型](./security/overview.md) → [oma 内核防线](./security/oma-kernel.md) → [bash 沙箱](./security/bash-sandbox.md) → [安全与债务清单](./security/debt.md) |
| 线上出问题 | [排障指南](./operations/troubleshooting.md) |
| 要把它跑起来 | [开发环境](../guides/development.md) → [排障指南](./operations/troubleshooting.md) |
| 动笔写代码前 | [设计哲学](./design-philosophy.md) → [跨进程契约规则](./e2e-contract-rules.md) → [DB 类型链规则](./db-typesafe-rules.md) → [依赖注入](./foundations/dependency-injection.md) |

## 页面清单

现状与基础

- [系统总览](./system-overview.md)
- [事实与投影](./foundations/facts-and-projections.md)
- [标识符体系](./foundations/identifiers.md)
- [生命周期总览](./foundations/lifecycle-overview.md)
- [依赖注入](./foundations/dependency-injection.md)

数据与历史

- [Product Backend 总览](./backend/overview.md)
- [数据模型](./backend/data-model.md)
- [Conversation History](./conversation/history.md)
- [Agent Context](./agents/context.md)
- [Agent 工作区与多后端](./agents/workspace-and-backends.md)
- [Run 输出与实时更新](./runs/output-and-live-updates.md)

执行链

- [Agent Backend](./execution/agent-backend.md)
- [Oma Runtime](./runtime/oma.md)
- [Oma Tools](./runtime/oma-tools.md)
- [模型与 Provider](./runtime/models.md)
- [Compaction](./runtime/compaction.md)
- [Oma 插件与 HITL](./plugins/oma-plugins.md)
- [渐进式技能插件](./plugins/progressive-skill.md)
- [技能包管理](./plugins/skill-pack.md)

编排与项目

- [Agentic Workflow](./workflow.md)
- [Project 与 Worktree](./agents/projects-and-worktrees.md)

端与流程

- [端总览](./surfaces/overview.md)
- [Web 端](./surfaces/web.md)
- [飞书](./surfaces/lark.md)
- [Web 消息端到端](./flows/e2e-web-message.md)
- [飞书消息端到端](./flows/e2e-lark-message.md)

安全与运维

- [安全模型](./security/overview.md)
- [oma 内核防线](./security/oma-kernel.md)
- [bash 沙箱](./security/bash-sandbox.md)
- [安全与债务清单](./security/debt.md)
- [排障指南](./operations/troubleshooting.md)

规则

- [设计哲学](./design-philosophy.md)
- [跨进程契约规则](./e2e-contract-rules.md)
- [DB 类型链规则](./db-typesafe-rules.md)

## 核心概念

术语以这张表为准。同一个词在别处写法不同，按这里理解。

| 词 | 定义 |
|---|---|
| Agent | 一个可被指派工作的成员：身份、记忆、技能、默认模型都在它的工作区文件里 |
| Conversation | 人与一个 Agent 的 1:1 对话（[ADR 0021](../adr/0021-one-conversation-one-agent-member.md)） |
| Message | 对话轮次的领域对象，人和 Agent 都产生 Message |
| Conversation History | 一场对话里共同发生的事实，存在账本里 |
| Agent Context | 某个 Agent 实际消费和保留的语义历史 |
| Context Branch | Agent Context 里一条可 fork、可回滚的历史路径 |
| Agent Run | Context Branch 上一次持久的产品级执行，是唯一的执行身份 |
| Agent Backend | 执行 Agent Run 的引擎边界，有 oma / claude / pi / omp 四个实现 |
| Workspace Bridge | 把技能、MCP、产品工具幂等写进 Agent 工作区文件的后端机制 |
| Product Tool | 由 Product Backend 执行的产品能力（History 读写、todo、审批等），以 MCP server + 每次 Run 独立 token 的形式提供 |
| Workflow | 声明式节点图编排：agent / script / human 节点加 JSON-Logic 边，可被 cron 触发 |
| Artifact | 带类型的产物，用 `artifacts://` 引用，能在节点之间和对话里传递 |
| Oma | 本仓库自研的 CLI 执行引擎，有 print / json / rpc 三种一次性模式和 TUI 交互终端 |
| Coding | Web 里的 worktree 终端页：每个 Project 下若干终端面板，面板可以跑 shell，也可以把 oma 拉起来交互 |

## 稳定约束

这几条改了就要连带改好几页，动之前先想清楚。

```text
Conversation History 存共享事实，Agent Context 存单个 Agent 的实际历史。
Agent Run 是唯一的执行身份。
每一次 Agent Run 都由 Agent Backend 起一个一次性子进程。
Agent 的配置、技能、记忆都在工作区文件里，不在数据库里。
```

- 没有跨 Run 的会话、resume 或常驻进程。上下文续接靠各后端自己的原生 session，产品只存一个引用。
- 流式输出不写进 Conversation History，也不写进 Agent Context。
- Agent 的最终 Message 与 Context 引用在同一个事务里提交，用 `agent_run_id` 标记这一次提交。
- Product Tool 的权限和事实都归 Product Backend。
- oma 子进程内部的 loop、retry、compaction、todo、技能加载是它自己的实现，产品侧不依赖。

## 写这一区页面的规矩

一页只讲一件事，标题直接说这件事是什么。开头一句话交代这页是哪个东西的权威描述，然后给范围（覆盖什么、不覆盖什么）和相关实现文件，正文按事实分小节，不按重要性排比。

只写代码此刻的样子。迁移过程、旧包名、临时兼容路径不进正文，它们属于 ADR 和 git。

已删除的概念不留页面，也不在正文里当反例反复提。`span`、`attempt`、`session 持久化`、`daemon`、`checkpointer`、`Pet`、`Recap`、多成员对话、`Loop`、`CronJob` 这些在代码里已经没有了，页面一并删掉；要知道它们为什么消失，去 [`../adr/`](../adr/README.md) 查。

同一条事实只写一遍。别的地方需要，链接过来。
