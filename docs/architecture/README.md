---
id: architecture.index
title: 架构 Wiki 首页
status: current
owners: architecture
last_verified_against_code: 2026-06-22
summary: "这是给人看的架构 Wiki 入口。它不是按里程碑流水账排的，而是按「你想干什么」组织阅读路线。先在这里选好路线，再去读具体实现页。"
depends_on:
used_by:
---

# 架构 Wiki 首页

这是给人看的架构 Wiki 入口。它不是按里程碑流水账排的，而是按「你想干什么」组织阅读路线。先在这里选好路线，再去读具体实现页。

## 这份 Wiki 想做到什么

读完相关页面，你应该不用翻源码就能讲清楚系统是怎么运转的——一条消息怎么从输入框走到账本、一次运行怎么被监督和恢复、一份产出怎么被去重地送到飞书。每一页都同时为两类读者写：人读正文（中文叙述、配图、伪代码），机器读元数据（页首 frontmatter 的 `summary` / `depends_on` / `used_by`，外加独立的 `index.llm.md` 和 `concepts.json`）。

## 推荐阅读路线

### 想搞懂整个系统

1. [系统总览](./system-overview.md)
2. [事实与投影](./foundations/facts-and-projections.md)
3. [Web 消息端到端](./flows/e2e-web-message.md)
4. [会话投影](./backend/conversation-projection.md)
5. [排障手册](./operations/troubleshooting.md)

### 在后端运行时上干活

1. [后端总览](./backend/overview.md)
2. [RunSupervisor](./backend/run-supervisor.md)
3. [EventLog](./backend/event-log.md)
4. [会话投影](./backend/conversation-projection.md)
5. [数据模型](./backend/data-model.md)

### 在 Runner / Agent 运行时上干活

1. [常驻 Runner](./runner/resident-runner.md)
2. [Runner 协议](./runner/runner-protocol.md)
3. [AgentSpec](./backend/agent-spec.md)
4. [Framework 运行时](./runtime/framework.md)
5. [Agent 文件系统](./runner/agent-file-system.md)

### 在 Web 或飞书端干活

1. [端总览](./surfaces/overview.md)
2. [Web 端](./surfaces/web.md)
3. [飞书适配器](./surfaces/lark-adapter.md)
4. [对话账本](./conversation/ledger.md)
5. [飞书消息端到端](./flows/e2e-lark-message.md)

### 想搞懂 Issue 与协作编排

> `foundations/issue.md`、`backend/orchestrator.md`、`flows/e2e-issue-lifecycle.md` 已落地代码（`status: current`）。`foundations/issue-workflow.md`（`status: design`）是下一版演进设计。

1. [Issue](./foundations/issue.md)
2. [Orchestrator](./backend/orchestrator.md)
3. [Issue 生命周期端到端](./flows/e2e-issue-lifecycle.md)
4. [Issue 工作流演进](./foundations/issue-workflow.md)（`status: design`）

## 给 LLM 的入口

- [LLM 索引](./index.llm.md)：按问题类型给出「先读这几页」的路由。
- [概念图谱](./concepts.json)：机器可读的页面依赖图。
- [跨页地图](./map.md)：给人看的依赖关系图。

## 每页的固定骨架

核心页大致是这个顺序，方便你在不同页之间快速定位：

1. 页首一句话导读（H1 正下方那段）。
2. 这页解决什么问题。
3. 现在代码怎么做的（真实符号名、控制流、配图）。
4. 输入与输出。
5. 关键数据结构。
6. 运行时序。
7. 不变量。
8. 失败模式。
9. 例子。
10. 当前缺口。
11. 关联页面。

## 一条规则：先写现状

正文描述的是「当前代码就是这么跑的」。还没落地的设想统一放进 [未来工作](./roadmap/future-work.md) 或某页的「当前缺口」小节，不要混进现状描述里——否则读者会把愿景当成已实现。
