# CrewDesk (my-agent-team) 项目 Wiki

这是本仓库的 wiki：产品是什么、怎么跑起来、系统怎么搭的、为什么这么搭、还有什么没做。

代码是唯一事实来源。这里的每一页要么描述代码**此刻**的样子，要么记录它**为什么**变成这样；两者不混写。对不上代码的现状页就是 bug，`bun run audit:docs` 会在 CI 里把死链、死路径和"教已删除概念"的页拦下来。

## 四个分区

| 分区 | 位置 | 回答什么问题 | 纪律 |
|---|---|---|---|
| 现状 | [`architecture/`](./architecture/README.md)（[中文入口](./architecture/README.zh-CN.md)） | 代码此刻长什么样 | 改代码的 PR 同 PR 改对应页 |
| 决策 | [`adr/`](./adr/README.md) | 为什么是现在这样（含被推翻的决策） | 只追加；状态翻转同 PR 改索引 |
| 指南 | [`guides/`](./guides/development.md) | 怎么跑起来、用起来、出问题怎么查 | 跟着实际命令改，不写「大概」 |
| 路线 | [`roadmap.md`](./roadmap.md) | 还没做什么、为什么还没做 | 只有这里谈将来 |

## 从哪读起

第一次进这个仓库，先看 [系统总览（中文）](./architecture/system-overview.zh-CN.md)（或 [System Overview](./architecture/system-overview.md)），再回 [架构索引（中文）](./architecture/README.zh-CN.md) 认词——那份核心概念表是全仓术语的基准。

要动代码，先过三份规则页：[设计哲学](./architecture/design-philosophy.zh-CN.md)（[EN](./architecture/design-philosophy.md)）、[跨进程契约规则](./architecture/e2e-contract-rules.md)、[DB 类型链规则](./architecture/db-typesafe-rules.md)。动手前的编码规范在仓库根的 [`AGENTS.md`](../AGENTS.md)。

只想把它跑起来，看仓库根的 [`README.md`](../README.md) / [`README.zh-CN.md`](../README.zh-CN.md) 快速开始；日常操作进 `guides/`。

查某个决策的来龙去脉，从 [`adr/README.md`](./adr/README.md) 的索引进——每个 ADR 都标了状态，被取代和已作废的也在里面，别只看标题就当成现行规则。

安全边界与已知接受的残余风险都在 [`architecture/security-model.md`](./architecture/security-model.md)。

## 按任务找页

| 要做的事 | 读这几页，按顺序 |
|---|---|
| 看懂整体 | `architecture/system-overview.zh-CN.md` → `architecture/data-model.md` → `architecture/agent-run-execution.md` → `architecture/team-coordination.md` |
| 改消息、账本与上下文 | `architecture/conversation-and-context.md` → `architecture/agent-run-execution.md` → `architecture/data-model.md` |
| 改执行链或 ACP 后端适配 | `architecture/agent-run-execution.md` → `architecture/acp-backend-contract.md` → `architecture/oma-runtime.md` |
| 改 PA+Worker 派单与 Product MCP | `architecture/team-coordination.md` → `architecture/proactive-and-knowledge.md` → `architecture/agent-run-execution.md` |
| 改工作区、项目与 Coding 终端 | `architecture/workspaces-and-projects.md` → `architecture/security-model.md` → `architecture/web-surface.md` |
| 改 Workflow 或 Artifact | `architecture/workflow.md` → `architecture/data-model.md` → `architecture/workspaces-and-projects.md` |
| 改 Web 端或 AHP 协议 | `architecture/ahp-surface-contract.md` → `architecture/web-surface.md` → `architecture/e2e-contract-rules.md` |
| 改飞书端 | `architecture/lark-surface.md` → `architecture/ahp-surface-contract.md` → `architecture/proactive-and-knowledge.md` |
| 改自研 `oma` runtime / 技能 / 插件 | `architecture/oma-runtime.md` → `architecture/skills-and-plugins.md` → `architecture/compaction.md` → `architecture/models-and-providers.md` |
| 查安全边界与债务 | `architecture/security-model.md` |
| 查 DI、`oma gateway` 或线上排障 | `architecture/operations-and-gateway.md` |

## 改这个 wiki 的规矩

现状页只写代码此刻的样子。历史改动、迁移过程、临时兼容路径不进现状页：决策记进 [`adr/`](./adr/README.md)，其余交给 git。

已删除的概念不保留页面。`span`、`attempt`、`session 持久化`、`daemon`、`checkpointer`、`Pet`、`Recap`、`Loop`、`CronJob`、`knowledge_pack` 这些都已经从代码里删干净了，wiki 里不留它们的页，历史只在 ADR 和 git 记录里。

一页只讲一件事，页与页靠链接连起来，不靠复制。深层架构规范以 `docs/architecture/` 下的英文单源为准，仅三篇入口页提供中文镜像。
