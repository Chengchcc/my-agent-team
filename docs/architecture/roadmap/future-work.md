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
- **可配置编排引擎**　[Orchestrator](../backend/orchestrator.md) 当前是一张固定线性转移表（计划中→开发中→待 Review→已完成）。未来可让转移从「写死的常量」长成「可配置」——条件分支、并行 fork/join 等。落地时应在**同一个 Orchestrator 名字下**替换转移表的形态，而非新增概念；引入新机制（DAG 节点/边/上下文传递）前先确认存在真实的多形态需求，避免过度设计。依赖：[Orchestrator](../backend/orchestrator.md)、[Issue](../foundations/issue.md)。
- **@提及收编进编排**　现状里 @提及自动触发（`onRunComplete` 扫描文本 → `forkAgentRuns`）和 Orchestrator 的状态机推进是两套驱动。未来可把对话内的 @提及招呼也统一交给编排器调度，让「下一步谁干」只有一个权威来源。依赖：[Orchestrator](../backend/orchestrator.md)、[对话与成员](../conversation/conversation-and-members.md)。

## 处理原则

这个项目对技术债的态度是**及时彻底修复，没有任何项目内容不可改动**。因此这一页不是「攒着不还的债务清单」，而是「明确标注、择机推进、改动时一并到位」的方向记录。任何一项推进时，都应连带更新它所依赖页面的当前状态描述，使文档持续与代码对齐。

## 关联页面

- [架构 Wiki 首页](../README.md)
- [事实与投影](../foundations/facts-and-projections.md)
