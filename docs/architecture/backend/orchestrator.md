---
id: backend.orchestrator
title: Orchestrator
status: current
owners: backend-runtime
last_verified_against_code: 2026-06-18
summary: "Orchestrator 是驱动 Issue 状态机往前走的显式编排器。它取代了原来靠 @提及自动触发的脆弱链路：现在「下一步该谁干、干完进哪个状态」是一张固定的线性转移表，配两个纯函数——① prompt 模板插值（字符串 + {{}}，刻意不引入模板 DSL）；② status 回填监听器（run 终态 → 推进到下一状态）。命名为 Orchestrator 是有意为之：它当前是固定转移的雏形，为后续长成可配置编排引擎预留概念位，无需改名。"
depends_on:
  - foundations.issue
  - backend.run-supervisor
  - conversation.members
used_by:
  - flows.e2e-issue-lifecycle
---

# Orchestrator

> 本页 `status: current`：已落地为代码。
> - 转移表：`apps/backend/src/features/orchestrator/transitions.ts`
> - renderPrompt：`apps/backend/src/features/orchestrator/render.ts`
> - 回填监听器：`apps/backend/src/features/orchestrator/reactor.ts`

Orchestrator 是驱动 [Issue](../foundations/issue.md) 状态机往前走的显式编排器。Issue 定义「一件活有哪些状态」，Orchestrator 定义「状态之间怎么推进、每一步跑什么」。

## 这页解决什么问题

现状里，多 Agent 协作靠 **@提及自动触发**：一个 Agent 的产出文本被 `onRunComplete` 扫描，命中 `@某人` 就 `triggerMentionedAgents` 起下一棒（见[对话与成员](../conversation/conversation-and-members.md)）。这条链路脆在三点：

- **隐式**：下一步该谁干，藏在上一个 Agent 的自由文本里。模型少打一个 @、换了个说法，链路就断。
- **不可观测**：没有「这件活推进到第几步」的显式状态，只有一连串运行。
- **难约束**：只能靠跳数上限兜底防失控，无法表达「计划没通过就不许进开发」这种工作语义。

Orchestrator 把「下一步是什么」从模型的自由文本里**拿出来**，固化成显式机制：一张转移表 + 两个纯函数。

## 当前形态：固定线性转移表

转移表是一个**常量**，不可在运行时配置：

```ts
// 固定线性推进，与 Issue.status 一一对应
const TRANSITIONS = [
  { from: "planned",     to: "in_progress", agent: "planner"   },
  { from: "in_progress", to: "in_review",   agent: "developer" },
  { from: "in_review",   to: "done",        agent: "reviewer"  },
] as const;
```

每条转移说明：处于 `from` 状态时，由哪个 `agent` 干活；干完后 Issue 进入 `to` 状态。整张表是线性的、写死的——没有分支、没有并行、没有条件跳转。

## 两个纯函数

Orchestrator 的全部行为就两个纯函数，刻意保持小而无状态：

### ① prompt 模板插值

给定一个 prompt 模板字符串和一个变量字典，把 `{{var}}` 占位符替换成实际值：

```ts
function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}
```

**刻意不引入模板 DSL**：没有条件、没有循环、没有过滤器，就是字符串 + `{{}}` 替换。模板里要表达的逻辑，应该长在转移表或 Agent 自身，而不是塞进模板语言。这是按[设计哲学](../design-philosophy.md)「概念要少」做的减法——一个全功能模板引擎是又一层要学的心智，现在不需要。

### ② status 回填监听器

监听 run 终态，把 Issue 推进到下一状态：

```text
run 终态(succeeded) 命中某个 Issue 的当前转移
  → 查 TRANSITIONS 找到 from = Issue.status 的那条
  → 写 Issue.status = transition.to
  → 若存在下一条转移，用 renderPrompt 拼 prompt，经 RunSupervisor 起下一棒
```

这是个纯粹的「事件 → 状态推进」回填器：它不持有自己的状态，所有事实都落在 Issue 上。run 怎么起、怎么收尾，完全复用 [RunSupervisor](./run-supervisor.md) 现有机制。

## 与 @提及的关系

Orchestrator **取代** @提及自动触发作为 Issue 推进的驱动方式：

| | @提及自动触发（现状） | Orchestrator（本设计） |
|---|---|---|
| 下一步从哪来 | Agent 产出文本里的 `@` | 固定转移表 |
| 是否显式 | 隐式 | 显式 |
| 推进状态 | 无，只有连串运行 | Issue.status |
| 失控防护 | 跳数上限兜底 | 转移表本身有限且线性 |

@提及作为**对话内**的人/Agent 互相招呼仍然保留；但「一件活按状态推进」改由 Orchestrator 驱动，不再依赖模型在文本里 @ 对人。

## 为什么叫 Orchestrator

当前它只做固定线性转移，几乎称不上「编排」。叫 Orchestrator 是为演进**预留概念位**：下一步迭代会让转移从「固定常量」长成「可配置」，那时它名副其实，且**不用改名**——避免将来一次概念重命名波及全仓。按[设计哲学](../design-philosophy.md)「名字就是架构」，先把名字摆对，比先把功能做满更重要。

## 设计取舍

### 为什么现在不做可配置 DAG 工作流引擎

可配置工作流（有向图、条件分支、并行 fork/join、可视化编辑）是诱人的方向，但现在**刻意不做**：

- 固定线性转移已能覆盖「计划→开发→Review→完成」这条主线，是当前唯一需要的形态。
- 一个 DAG 引擎会引入大量新概念（节点、边、条件、上下文传递），违反「概念要少」。在没有真实多形态需求前，它是过度设计。
- 先用固定表把 Issue 状态机跑通、把 Orchestrator 这个边界立住，等真实需求出现，再在**同一个名字**下把转移表换成可配置的——这是平滑演进，不是推倒重来。

可配置 DAG 编排引擎、以及把 @提及自动招呼也收编进编排（`@提及 → forkAgentRuns` 统一由编排器调度）属于后续方向，记在[未来工作](../roadmap/future-work.md)里，不在本设计范围。

## 不变量

1. 「下一步是什么」由显式转移表决定，不从 Agent 自由文本里推断。
2. Issue 的状态推进只经 status 回填监听器写入，单一写者。
3. prompt 模板仅做 `{{}}` 字符串插值，不引入模板 DSL。
4. Orchestrator 不发明执行机制，run 的发起与收尾全复用 RunSupervisor。

## 关联页面

- [Issue](../foundations/issue.md)
- [RunSupervisor](./run-supervisor.md)
- [对话与成员](../conversation/conversation-and-members.md)
- [未来工作](../roadmap/future-work.md)
- [架构设计哲学](../design-philosophy.md)
