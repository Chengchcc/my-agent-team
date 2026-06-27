---
id: foundations.identifiers
title: 标识符体系
status: proposed
owners: architecture
last_verified_against_code: 2026-06-26
summary: "系统里的 id 不是一堆并列的字符串，而是两类截然不同的东西：实体主键（conversationId / agentId / issueId / cronJobId / memberId，各自独立、ulid 生成、互不派生）和运行上下文 id（sessionId / runId / attemptSeq，沿一条派生链层层收束）。本页用第一性原理说明「哪个 agent、在哪个上下文里、的那条持久记忆线」就是一个 session，它的本体在最底层 checkpointer 里早就只有一个 key——今天叫 threadId，应正名为 sessionId。run 是 session 上的一次 prompt loop，attempt 是 run 内的重试序号、不配独立 id。本页同时立下「每个 id 归属哪一层」的准则：checkpointer 只认 sessionId，EventLog 按 runId 切事实流，backend 拥有 run/attempt 调度。"
depends_on:
  - design-philosophy
  - foundations.facts-and-projections
used_by:
  - harness.harness
  - runtime.framework
  - backend.overview
---

# 标识符体系

这个仓里散落着不少 id：`conversationId`、`agentId`、`memberId`、`issueId`、`cronJobId`、`threadId`、`runId`、`attemptId`。新接手的人第一反应是「怎么这么多」。但它们不是平级的——把它们摆对位置后，真正的领域 id 只有少数几个，其余要么是实体主键，要么是同一条派生链上的不同粒度。

本页要回答三个问题：

1. 这些 id 各自是什么，谁派生谁？
2. 「那条持久记忆线」的本体到底是谁，为什么它该叫 `sessionId` 而不是 `threadId`？
3. 每个 id 归属哪一层（backend / harness / checkpointer），谁有权发明它？

> 这页是 `proposed`：它描述的是收敛后的目标模型。代码现状（基准 HEAD `e5a4b390`）在末尾「现状与目标的差距」一节如实列出，不粉饰。

## 两类 id，先分清

所有 id 先劈成两类，混在一起讲是一切困惑的根源。

### 第一类：实体主键（独立、不派生）

它们标识一个**独立存在的领域实体**，各自用 `ulid()` 或 `randomUUID()` 生成，彼此之间没有派生关系：

| id | 实体 | 生成 |
|----|------|------|
| `conversationId` | 一场会话 | 独立 |
| `agentId` | 一个 Agent | 独立 |
| `memberId` | 会话里的一个成员（人或 agent） | 独立 |
| `issueId` | 一个 Issue | `idGen()`（`issue/service.ts:71`） |
| `cronJobId` | 一个定时任务 | 独立 |

这类 id 的特点：**它回答「这是哪一个东西」，不回答「它在哪个上下文里运行」**。删掉运行时，它们照样存在。

### 第二类：运行上下文 id（派生链）

它们标识「一次 Agent 运行的某个粒度」，沿一条链层层收束：

```text
sessionId  ← 哪个 agent、在哪个上下文里、的那条持久记忆线
   │  （派生自实体主键，见下）
   └── runId  ← 这条线上的一次 prompt loop
          │
          └── attemptSeq  ← 这次 run 内的第几次重试
```

这三者不是三个独立实体，而是**同一次运行的三个缩放级别**：session 是整条记忆线，run 是其中一轮对话循环，attempt 是一轮里的一次执行尝试。

## 本体是 session，它的 key 在最底层早就统一了

用户的直觉是对的：「哪个 agent、在哪个上下文里、的那条持久记忆线」应该就是一个 **session**。而代码最底层正好印证了这一点——

`Checkpointer` 接口的七个方法（`load` / `save` / `saveInterrupt` / `consumeInterrupt` / `appendEvent` / `readEvents` / `deleteThread`）**每一个的入参都只有一个 id**（`packages/framework/src/checkpointer.ts:45`）。sqlite 实现的三张表（`checkpoint_messages` / `checkpoint_interrupts` / `checkpoint_events`）主键全是它，`save` 是按它做的 upsert（`sqlite-checkpointer.ts` 的 `onConflictDoUpdate`）。

也就是说：

> **最底层存储里，「那条持久记忆线」只有一个 key。它持久、唯一、就是 session 本身。checkpointer 从不知道 `runId` 或 `attemptId` 的存在。**

这个 key 今天叫 `threadId`。但 `thread`（线程）是个机制词——它来自「消息线程」的实现联想，而非领域语言。领域里这条线就是一个 **session**：一个 agent 在一个上下文里的持久对话状态。所以正名是：

```text
threadId  →  sessionId
```

这不是改个名字的洁癖。按[架构设计哲学](../design-philosophy.md)「名字就是架构」，`threadId` 这个名字暗示它是消息层的实现细节，于是上面每一层都不把它当本体，各自又发明了自己的 key（见下节）。改名 `sessionId` 是把本体的身份立起来，让上层有一个清晰的东西可依附。

### sessionId 怎么派生

session 不是凭空生成的 id，而是由「哪个上下文 + 哪个 agent/成员」拼出来的稳定字符串。仓里有三种触发源，三条派生公式：

| 触发源 | sessionId（现 threadId）公式 | 代码 |
|--------|------------------------------|------|
| 会话 | `${conversationId}:${memberId}` | `conversation/service.ts:24` |
| Issue（创建） | `${issueId}:owner` | `issue/service.ts:72` |
| Issue（编排派活） | `${issueId}:${agentId}` | `orchestrator/reactor.ts:122` |
| Cron | `${cronJobId}:owner` | `cron/scheduler.ts:36` |

读法：**sessionId = 上下文实体主键 : 这条线归谁**。同一个 conversation 里两个成员各有自己的 session（记忆线不串），同一个 issue 派给两个 agent 也各有自己的 session。这正是「哪个 agent、在哪个上下文里」——两个维度拼成一条线的身份。

> 注意 Issue 当前有两种格式并存（`:owner` 与 `:${agentId}`）。这是历史演进留下的毛刺，收敛时应统一为 `${issueId}:${agentId}` 一种，让派生公式只有「上下文 : agent」这一个心智。

## run 是 session 上的一次 prompt loop

`run` 不是多余概念，它有清晰的领域含义：**session 上的一次 `prompt()` 调用——从用户（或触发源）给一个输入，到 agent loop 跑完为止**。一条 session 会经历多次 run：用户问一句是一个 run，下次再问是下一个 run，cron 到点触发又是一个 run。

`runId` 由 backend 在每次发起运行时 `crypto.randomUUID()` 生成（`conversation/service.ts:144`、`conv-svc-factory.ts:100`/`:157`），随后传进执行链。它的作用是给 EventLog 和 assistant 消息切片：`assistantMessageId(runId, ordinal)` 产出 `run:${runId}:assistant:${ordinal}`（`packages/message/src/helpers.ts`），`event_log` 表带 `runId` 列按 run 归集事实流。

所以 run 和 session 的分工是：

```text
session  →  这条线「当前是什么状态」（checkpointer 单行快照，被每个 run upsert 覆盖）
run      →  这条线「按一次次输入切分的事实流」（EventLog，每个 run 一段）
```

checkpointer 不按 run 隔离是**对的**——它存的就是 session 的当前状态，不是历史档案。要回看「第 3 个 run 开始前长什么样」，那是 EventLog 的职责，不是 checkpointer 的。两者的边界见[事实与投影](facts-and-projections.md)。

## attempt 是 run 内的重试序号，不配独立 id

`attempt` 的领域含义是：**同一个 run 因为崩溃/超时/重启，被重新执行的某一次尝试**。同一个 run 的多次 attempt 共享同一个输入和意图，只是物理上跑了不止一遍。

关键事实（HEAD 核实）：

- 全仓**只有一个** `INSERT INTO attempt` 站点（`supervisor.ts:186`），值恒为 `att-${runId}`。今天 attempt 与 run 是 **1:1**，`attemptId` 完全由 `runId` 派生，不携带任何额外信息。
- `attempt` 表的索引 `idx_attempt_run` 建在 `(runId, startedAt)` 上；reattach 取「最新活着的 attempt」用的是 `WHERE run_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`（`runtime-ops/service.ts`）。这正是「run 下的有序子项」语义。
- `run_ops_event.attemptId` 是 **nullable text，没有 `.references()`**（`events-schema.ts`）——它不是外键，只是审计标注列。没有任何强引用绑死 `attemptId` 的字符串形态。

结论：attempt 的真正身份是 `(runId, seq)` 复合键，`seq` 在 run 内单调递增。它本来就是个序号，不值得拥有一个全局 id。`att-${runId}` 应退化成 `seq=1`。这样消掉一个冗余 id，符合[设计哲学](../design-philosophy.md)「概念要少」。

> 唯一的前置确认：attempt 不作为对外稳定 opaque handle 被第三方引用。HEAD 核实——它只在 ops 内部用于「取最新活着的那次」和审计展示，无外部 API 把它当长期句柄。所以 seq 安全。

## resume 不需要新 id

`resume`（恢复）不是一次新 run，而是**同一个 run 被中断后从 checkpointer 续上继续跑**。它对应 `agent.continue()` 语义：同一条 session、同一个 runId、只是新开一次 attempt。所以 resume 既不需要新 sessionId 也不需要新 runId——它只是让 `attemptSeq` +1。把 resume 误当成新 run 来发 id，正是概念膨胀的典型来源。

## 每个 id 归属哪一层

这是用户最在意的一点：现状 id 没有清晰的层归属。收敛后的归属准则：

```mermaid
flowchart TB
  subgraph backend["backend 层"]
    RUN["runId 生成<br/>attemptSeq 调度<br/>run/attempt 生命周期"]
  end
  subgraph harness["harness 层"]
    SESS["AgentSession<br/>持有 sessionId 身份<br/>跨 run 活着"]
  end
  subgraph cp["checkpointer 层"]
    KEY["只认 sessionId<br/>存 session 当前状态"]
  end
  RUN -->|prompt(input, runId)| SESS
  SESS -->|load/save(sessionId)| KEY
```

- **checkpointer 层**：只认 `sessionId` 一个 key，存「这条 session 当前是什么状态」。不知道 run、不知道 attempt。
- **harness 层**：`AgentSession` 拥有 session 身份，**跨 run 活着**（见下文决定），按 `sessionId` 注册。每次 run 由 backend 通过 `prompt(input, { runId })` 把当次 runId 显式传进来。
- **backend 层**：拥有 `runId` 的生成与 `attemptSeq` 的调度、run/attempt 的生命周期（supervisor）。它不发明 session 的身份，只在已有 session 上发起一次次 run。

一句话准则：**sessionId 属于最底层（存储事实），runId/attemptSeq 属于最上层（调度事实），harness 居中、持有 session 对象但接收 runId**。谁发明 id 的标准是「谁拥有这个粒度的事实」，不是「谁用起来方便」——后者正是[设计哲学](../design-philosophy.md)警告的「模块边界复制成领域边界」。

## 决定：AgentSession 跨 run 持久

既然本体是 session、checkpointer 早就只认 sessionId，那么 harness 的 `AgentSession` 就应该和这个本体对齐——**一个 sessionId 对应一个长期活着的 AgentSession，跨多个 run 复用**，而不是每个 run `new` 一个再 `dispose`。

这带来四点约束（收敛时必须满足）：

1. **registry 按 sessionId 做 key**，不再按 runId。
2. **run 结束只标记 run 终态，不销毁 session**。
3. **必须新增 session 回收策略**——这是跨 run 持久唯一引入的新成本。候选：idle timeout 回收、进程退出回收、显式 close（会话关闭 / agent 下线）。不定清楚就是内存泄漏。
4. **runId 必须真正流进 harness**。`prompt()` 要把当次 runId 透传到 run-loop，`assistantMessageId(runId, ordinal)` 才能在一条 session 服务多个 run 时不串号。

## 现状与目标的差距

如实记录 HEAD `e5a4b390` 与本页目标的偏离，供收敛时逐项消除：

- **AgentSession 是 per-run 的**：`session-registry` 按 `runId` 做 key，`executeAgentRun` 每 run `new` + `dispose`（`run-executor.ts`、`session-registry.ts`）。与「跨 run 持久」相反。
- **runId 不流进 harness**：`AgentSessionConfig` 只有 `threadId`、无 `runId`（`agent-session.ts:30`）；framework 用 `rt.runId = opts.runId ?? thread.id` 回退到 thread.id（`create-agent.ts`）。多个 run 落在同一条 session 时会共用一个 runId。
- **threadId 尚未正名**：全仓仍叫 `threadId`，本体身份没立起来。
- **attempt 仍有独立 id**：`att-${runId}` 而非 `attemptSeq`（`supervisor.ts:178`）。
- **Issue threadId 两格式并存**：`:owner` 与 `:${agentId}`，待统一。

这些不是 bug——系统今天能跑。但它们是[设计哲学](../design-philosophy.md)意义上的概念债：每层为自己方便发明了一个 key，让「一条 session」这件简单的事散在三层、三个名字里。

## 关联页面

- [架构设计哲学](../design-philosophy.md) —— 「名字就是架构」「概念要少」「模块边界 ≠ 领域边界」的总纲
- [事实与投影](facts-and-projections.md) —— checkpointer 存状态、EventLog 存事实流的边界
- [依赖注入](dependency-injection.md) —— executeAgentRun 现状的 DI 病灶，与本页的 id 病灶同源
- [Harness](../harness/harness.md) —— AgentSession 的构造与生命周期
- [Framework 运行循环](../runtime/framework.md) —— runId / thread.id 回退的发生处
