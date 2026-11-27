---
title: 设计哲学（中文）
description: CrewDesk 架构判断准则：八条核心原则、动手前三组检查、正反例、红旗信号与决策顺序
tags: [conventions, rules, zh]
---

# 设计哲学

> **语言说明**：**简体中文** · [English (canonical)](./design-philosophy.md)。

本页是写代码、做代码评审和更新文档前的架构判断准则。全篇只有一句话立场：

> **让领域心智保持简单稳定；实现机制可以复杂，但绝不能上浮成业务概念。**

复杂系统不会因为名词变多而变清楚。引入任何新类型、新表、新事件或新抽象前，先回答：*这个事实归哪个已有领域对象管？新名词是业务语言，还是泄露出来的实现细节？下一个接手的人（或 Agent）会不会因此多学一层？*

## 八条核心原则

1. **先统一语义，再选择机制**：从用户与 Agent 共同世界里的业务事实出发，而不是从表、队列、流或投影出发。
   - *反例*：落账定义 `LedgerMessage`，传输定义 `RunStreamMessage`，前端定义 `UiMessage`。
   - *正例*：本体只有一个 `Message`；账本行、AHP 包装、UI 渲染态、飞书投递记录只是围绕它的外壳或引用。
2. **同一语义对象只能有一个本体**：若两个类型描述的是同一条「谁在什么时候说了什么」、共享终态与等待态、界面上折叠为同一条、仅因所在模块不同而命名不同，就必须共用同一本体。
3. **实现机制不能上浮成业务心智**：只追加日志、投影、投递表与重试队列都应留在实现层。主叙述永远是「Run 产生 Message → Conversation 保存 Message → 端渲染 Message」，而非把内部事件和存储链路当成入门门槛。
4. **边界要硬，概念要少**：业务边界少而稳（`Agent`、`Conversation`、`Message`、`Agent Run`、`Requirement`、`Project`、`Workflow`、`Artifact`、`Wiki`、`Proposal`）；机制边界（`Ledger`、`Projection`、`Queue`、`Delivery`、`Lock`、`Cache`、`Index`）保持低调。
5. **名字就是架构**：把实现机制命名成领域对象，后续代码都会围着它长歪。宁写「会话存储里的 Message」「消息投递状态」，也不造 `LedgerMessage`、`LarkMessage`。
6. **Projection 是实现手段，不是主线**：如果新人必须先搞懂投影机制才能理解用户看到的消息，就说明机制已经上浮。
7. **控制环需要统一内模**：依据控制论 Good Regulator Theorem，当 Backend、子进程、Web 和飞书各持一套会漂移的消息/运行状态模型时，控制环必然裂开（一边以为结束、一边死等，或重复发消息）。
8. **警惕模块边界变成领域边界**：Conway 定律会在 monorepo 里复制出 `backend` / `web` / `lark-bot` 三套平行模型。每次设计都反问：*这是领域边界，还是仅仅跨了个包？*

## 动手前三组检查

- **概念检查**：引入新名词了吗？已有领域对象表达不了吗？它是否仅仅因为跨了进程、表或端才出现？若是，不要引入。
- **语义检查**：谁拥有它的身份、生命周期与终态？用户看得到吗？模型需要读吗？需要审计或投递吗？答案与已有对象一致就复用。
- **机制检查**：存储或传输名字进业务 API 了吗？端需要靠读内部遥测事件来反推用户可见状态吗？投递态或渲染态混进消息内容了吗？若是，立刻压回实现层。

## 正反例对照

| 场景 | 反例 | CrewDesk 现行做法 |
|---|---|---|
| **消息流转** | `RunEventMessage → LedgerMessage → UiMessage → LarkMessage` 四套漂移结构 | 统一使用 `@chengchenccc/message` 的规范 `Message`，各层只加外层元数据（账本 `seq`、AHP `_meta`、飞书 `message_delivery`）。 |
| **流式输出** | 每个增量分片建一条消息，各端自维护草稿 | 增量仅走 `/ws/ahp` 临时流；终态 `BackendRunOutcome` 单事务落账并折叠到同一轮次。 |
| **审计与用户事实分离** | 端直接消费 `agent_run_event` 拼聊天记录 | `agent_run.terminal_result`、`agent_run_event`、`product_tool_call` 用于排障审计；`conversation_ledger` 是唯一对话事实。 |
| **投递状态** | 为记录飞书发送重试而新建 `LarkMessage` 本体 | `Message` 只存内容；`apps/lark-bot` 在本地 `message_delivery` 表按 `(conversation_id, message_id, lark_chat_id)` 记录投递态。 |
| **HITL 等待态** | 审批请求只挂内存流，刷新或重启即丢失 | 审批/追问先持久化到 `pending_action` 再推送（ADR 0038/0039），同时驱动 `/ws/ahp` 卡片与 `GET /api/attention`。 |
| **Agent 修改配置** | 允许 MCP 工具直接覆盖 `agent.yml`、项目或工作流文件 | MCP 工具只生成持久化 `proposal` 行，人在 `ProposalCard` 核对差异后显式保存（ADR 0081）。 |

## 红旗信号

PR 出现任意一条就应停下来重审：

- 一个 PR 新增 3 个以上近义名词。
- 一个用户可见状态需要跨 2～3 处表或流推断才能得到。
- Web 或飞书必须判断子进程私有内部事件名才能正常工作。
- 同一条逻辑消息在不同层用不同规则生成 ID。
- 终态不在实体上表达，而是靠旁路事件推断。
- 领域类型带存储或传输前缀（`LedgerXxx`、`StreamXxx`、`UiXxx`）。
- 修一个消息 bug 要同时改三四个重复的 parser。

## 允许与不允许的复杂度

- **允许（藏在硬边界后）**：用于重放的只追加账本、用于排障的遥测白名单、端侧 at-least-once 投递表、读模型索引（`artifact`、`EntityLabelResolver`）、缓存与按 worktree 的互斥锁——*前提是不重新定义核心领域对象*。
- **不允许**：每个存储一套消息模型、每个端一套生命周期、多个层同时决定一轮是否结束、每包一份重复 normalizer，或先讲存储 plumbing 才能讲清楚用户行为。

## 决策顺序

永远自顶向下按这 8 步设计，不要从表、接口或 UI 组件倒推：

```text
1. 领域对象是什么？
2. 不变量是什么？
3. 生命周期在哪里结束？
4. 谁需要读它？
5. 谁有权写它？
6. 用什么机制保存它？
7. 哪些端投递或渲染它？
8. 哪些实现细节必须藏起来？
```

## 最后三句

```text
统一本体，不复制语义。
暴露业务，隐藏机制。
边界要硬，概念要少。
```

## 相关规范（英文权威版）

- [E2E Contract Rules](./e2e-contract-rules.md) — 跨进程单一真源与自动化门禁
- [DB Type-Safe Rules](./db-typesafe-rules.md) — SQLite 到 HTTP 的类型链规则
- [系统总览（中文）](./system-overview.zh-CN.md) — 这套哲学在系统分层上的落地
- [Operations & Gateway](./operations-and-gateway.md) — 组合根 DI 与进程生命周期边界
