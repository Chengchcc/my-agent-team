---
id: runner.runner-protocol
title: Runner 协议
status: current
owners: architecture
last_verified_against_code: 2026-06-16
summary: "Runner 协议是后端（Host）与常驻 Runner 之间的双向消息契约。它把「谁能发起什么、谁能上报什么」固化成两组有判别字段的消息类型：Host 只能下达 start / abort / run_finalized，Runner 只能上报 run_started / event / delta / heartbeat / run_done / daemon_health。这条协议是执行层和编排层之间唯一的通信面。"
depends_on:
  - backend.event-log
  - backend.agent-spec
used_by:
  - runner.resident-runner
  - backend.run-supervisor
---

# Runner 协议

Runner 协议是后端（Host）与常驻 Runner 之间的双向消息契约。它把「谁能发起什么、谁能上报什么」固化成两组有判别字段的消息类型：Host 只能下达 start / abort / run_finalized，Runner 只能上报 run_started / event / delta / heartbeat / run_done / daemon_health。这条协议是执行层和编排层之间唯一的通信面。

## 两个方向，两组消息

协议被显式拆成两个联合类型，方向不可混用：

**HostToRunner（后端 → Runner）**

| 消息 | 含义 |
|------|------|
| `start` | 发起一次运行；`preloadedMessages` 等启动数据随 `start` 携带，**不放在 AgentSpec 里** |
| `abort` | 请求中断当前运行 |
| `run_finalized` | 后端已完成收尾（账本写入、投影广播、订阅关闭），通知 Runner 这次运行在 Host 侧彻底结束 |

**RunnerToHost（Runner → 后端）**

| 消息 | 含义 |
|------|------|
| `run_started` | 反思（reflect）运行已在 Runner 侧创建，携带 spec 供后端创建数据库行；仅反思运行发送，非所有运行 |
| `event` | 一条结构化运行事件（将被后端写入 EventLog） |
| `delta` | 流式增量（文本/推理增量、工具开始/结束事件），用于实时渲染，不一定逐条落库 |
| `heartbeat` | 进程保活信号（每 5000ms） |
| `run_done` | 运行结束，携带终态 |
| `daemon_health` | 守护进程级健康汇报 |

## 为什么 preloadedMessages 走 start 而不是 spec

AgentSpec 描述的是「这个 Agent 是什么、用什么模式跑」（run / resume / reflect 的判别联合）。而 `preloadedMessages` 是「这一次具体要喂进去的对话」，属于**运行实例数据**而非 Agent 定义。把它放进 `start` 传输消息里，可以让同一个 spec 在不同运行里复用，也避免把易变的、可能很大的消息体塞进本应稳定的规格对象。

## start 消息的完整字段

`start` 消息除了 `type`、`runId`、`spec` 和 `preloadedMessages` 之外，还携带以下字段：

| 字段 | 类型 | 含义 |
|------|------|------|
| `reflect` | `boolean?` | 是否为反思运行（`spec.mode === "run"` 时置 true，后端据此判断是否需要在 run_done 后触发反思） |
| `surfaceContext` | `object?` | 端上下文（surface、conversationId、runId、capabilities），仅端触发的运行携带；反思运行时被剥离 |
| `trace` | `RuntimeTraceContext?` | 从后端传播到 Runner 的追踪上下文（M16） |

## run_started 消息形状

`run_started` 仅由 `#fireReflect()` 在创建反思运行后发送，不是所有运行都发。其形状：

```
{
  type: "run_started";
  runId: string;
  parentRunId: string;
  threadId: string;
  kind: "reflect";
  spec: Record<string, unknown>;
}
```

反思运行先注册到 `#runs`，再发 `run_started`（携带 spec 供后端创建正确的 DB 行），之后才 `#drive` 执行。

## event 与 delta 的分工

这是协议里最容易混淆的一对：

- `event` 是**会被持久化**的事实候选。后端收到后按顺序写入 EventLog，再由投影判断是否对话可见。
- `delta` 是**给眼睛看的**流式片段（`text_delta` / `reasoning_delta` / `tool_start` / `tool_end`），服务于「边生成边显示」。它的生命周期是实时订阅，不承担「这是历史事实」的角色。

理解这点就能理解一个关键不变式：**EventLog 的 append 一定发生在 onRunEvent 回调之前**——先把事实钉死，再触发下游投影，delta 流则是另一条并行的实时通道。

## 收尾握手：run_done → run_finalized

运行结束不是「Runner 说完就完」。顺序是：

1. Runner 发 `run_done`（携带终态：succeeded / error / aborted）；
2. 后端按固定顺序收尾——更新 attempt/run 状态 → 关闭 delta 订阅 → 从 `#active` 集合移除 → `await` 所有 `onRunComplete` 回调 → 发送 `run_finalized`；
3. Runner 收到 `run_finalized`，确认 Host 侧已彻底结束。

这个握手保证了「后端的投影和订阅都收尾完成」之后，双方才认为运行真正关闭，避免 Runner 抢跑导致下游还没消费完事件就被清理。

## 关联页面

- [常驻 Runner](resident-runner.md)
- [运行编排器](../backend/run-supervisor.md)
- [事件日志](../backend/event-log.md)
- [Agent 规格](../backend/agent-spec.md)
