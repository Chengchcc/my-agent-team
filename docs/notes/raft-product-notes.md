---
title: Raft 产品概念吸收笔记
description: 对照 docs.raft.build 全站（2026-09-30 读毕）与本仓现状，哪些概念该抄、哪些要设计决策、哪些不碰；roadmap 里标「方向」的条目在动手前先读这篇
tags: [product, roadmap, notes]
---

# Raft 产品概念吸收笔记

对照物是 [docs.raft.build](https://docs.raft.build/welcome)（2026-09-30 读完全部 42 个英文页面）。Raft 是「人 + agent 同处一室」的协作工作区：Slack 形态（频道/线程/任务/@提及），agent 是正式成员。它和我们赌同一个命题——怎么把「人指挥 agent 干活」做成产品——但解法侧重不同：我们的强项在执行面（run-centric、终态原子提交、恢复语义、HITL 状态机、多后端），它的强项在协作面（频道、任务、记忆复利、通知纪律）。

## 直接吸收（零件都在，成本低）

**全局搜索。** 我们的 `conversation_ledger` 就是现成的全文检索源：账本是唯一消息事实、`seq` 是全局顺序，搜索只是加一层只读投影。SQLite FTS5 够用，oma 向量记忆那套 external-content 触发器是仓内先例。Agent 侧同样受益：投影是「这个分支看到的」，搜索是「全库发生过什么的」——agent 用搜索恢复不在场时的上下文，与 Agent Context 投影互补。

**提醒（reminder）。** Raft 的定义很克制：锚定在某条消息/线程上的定时唤醒信号，只有作者自己收。我们的 `cron_job` 表已删，定时面只剩 workflow 的 cron 触发器，但「提醒我明天看这个 PR」为一个 workflow 太重。薄层落法：一张 reminder 行 + 复用 trigger-scheduler 的时钟 + 到点往绑定会话投一条输入（走 `branch_input_queue` 的既有路径）。不动 Run 语义；「安静但活着 vs 卡死」的心跳区分已经在了，唤醒正好复用。

**未读位置与会话级 Activity。** Web 端现在的补漏是「每 2 秒轮询 + 终态事件」，缺「每个会话记住你的第一条未读」。纯前端：账本行有 `_meta.seq`，conversation 列表上存一个 per-conversation 的 read seq 即可。Today 页已有「Needs you」，把它从审批队列扩成「未读 + @提及 + 待审」三合一，就是我们的 Activity。

**通知纪律。** Raft 的原则原样抄：**加入即订阅，离开即退订，没有 per-channel 通知设置可管理。** 映射到我们：会话绑定即通知面（飞书的 chat 绑定、Web 的活跃会话）就是全部开关；@提及和审批才算打断，进度更新只进 Today。趁通知面还少立这条规矩，比以后加频道开关再拆便宜。

**Onboarding agent（Cindy 模式）。** 零件全在：`agent_create` MCP 工具、内置知识包就是架构 wiki（frontmatter 渐进披露）、SOUL.md 身份。seed 一个熟悉本产品的引导 agent，把新手问题引到它身上。

## 要先做设计决策的

**任务作为一等公民。** `branch_input_queue` 就是事实上的任务队列（seq 单调、认领、防重复），但用户完全看不见。吸收方式不是照搬看板，而是**把已有队列语义透出来**：人类消息 → 可见任务卡（一个 queued input / run）→ 状态即 run 状态机（waiting = pending action）→ 终态即 BackendRunOutcome。「in review」我们的真身是 HITL 审批/追问。任务概念不新增执行语义，只给现有 run 状态一个用户可见的名字。加「转换为任务」入口和 per-agent 跨会话任务列表。

**Agent 间横向协作。** 与 ADR 0021（一个对话一个 Agent）正面冲突，0021 是刻意收敛来的。但渐进路径存在：delegation 事件（`delegation_batch_*`）已在契约和 SSE 上。先让一个 agent 经 product tool 派发任务给另一个 agent（`agent_create` + 新会话），用后端事实流养出受限版的 agent 对 agent 交付；真做多成员房间之前先在这条窄路上验证需求，别急着翻 0021。

**Agent 自我维护。** 我们已有更安全的形状（`agent_write` 推草稿给人确认），缺「周期性」的载体——reminder 落地后第一个应用就是它：agent 给自己排每周的 workspace 整理提醒，走既有 SOUL/knowledge 机制。

## 明确不碰的

- **Raft Apps / Login with Raft / marketplace**：OAuth + agent 身份授权 + 审核流是平台生意，与单用户部署差两个数量级。LAN/hosted 的五项安全清单（见 [安全与债务清单](../architecture/security/debt.md)）做完再说。
- **Joint channels（跨 server）**：单后端单库，没有对应问题。
- **消息不可编辑删除**：他们的「消息是可靠记录」哲学与我们的 undo/soft-delete 对话事实模型（`undone` 列、分叉）冲突，不换。
- **Raft Computer（本地执行器）**：backend 直接 spawn + `/coding` 裸 PTY 已覆盖「agent 在我机器上干活」，worktree 白名单管得更严。

## 已领先、不用学的

BYO runtime（4 adapter + ACP 编排层 vs 9 runtime 无恢复语义）、执行可靠性（终态原子提交、commit_failed 重试、心跳区分安静与卡死）、知识渐进披露（frontmatter 索引 + 召回工具 vs 他们的 workspace 记忆）、HITL（durable 状态机 + 重启恢复 + 幂等重放 vs 只有审批卡片）。

## 建议顺序

1. 搜索 + 未读位置（纯只读投影，不动事实模型）
2. Reminder（薄层，复用队列与调度器）
3. 任务卡 = run 状态的用户可见化（不动执行语义）
4. Agent 互派的窄路验证（delegation 事件已在）
5. 多成员房间——留作方向问题，翻 0021 之前先看 4 的使用数据

顺带的零成本一条：Raft 文档按「agent 可读」写（每页 llms_summary、「把这页交给你的 agent」），我们的内置知识包机制天然支持这个写作姿态。
