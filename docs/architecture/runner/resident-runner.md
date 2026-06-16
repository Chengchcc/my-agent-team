---
id: runner.resident-runner
title: 常驻 Runner
status: current
owners: architecture
last_verified_against_code: 2026-06-16
summary: "常驻 Runner 是真正执行 Agent 的统一进程（RunnerDaemon 类）。每个 Agent 对应一个独立的 RunnerDaemon 实例；它本地维护自己的 checkpointer.sqlite 用于断点恢复，通过两个内部定时器（heartbeat + daemon_health）向后端证明自己还活着，但它完全不懂对话语义，也不知道飞书的去重规则——它只负责跑、只负责把事件原样上报。"
depends_on:
  - runner.runner-protocol
  - runner.agent-file-system
used_by:
  - backend.run-supervisor
---

# 常驻 Runner

常驻 Runner 是真正执行 Agent 的统一进程（`RunnerDaemon` 类）。每个 Agent 对应一个独立的 `RunnerDaemon` 实例；它本地维护自己的 checkpointer.sqlite 用于断点恢复，通过两个内部定时器（`#heartbeatTimer` 和 `#daemonHealthTimer`）向后端证明自己还活着，但它完全不懂对话语义，也不知道飞书的去重规则——它只负责跑、只负责把事件原样上报。

## 为什么要常驻

一次 Agent 运行可能跑很久（多轮工具调用、反思、被中断后恢复）。如果每次请求都新起进程，热数据（已加载的技能、内存映射、模型客户端）全部要重建，而且断点恢复会很脆弱。所以这里选择**每个 Agent 一个常驻进程**：进程在第一次被需要时拉起，之后一直活着等下一次 `start`。

进程与 Agent 是一一对应的，因此进程内的状态（checkpointer、surfaceContext）天然按 Agent 隔离，不需要在内存里做多租户路由。

## 保活与心跳

`RunnerDaemon` 类内部维护两个定时器：`#heartbeatTimer` 每 **5000ms** 向后端发一次 `heartbeat`（按活跃 runId 逐条发送），`#daemonHealthTimer` 每 **10000ms** 向后端发一次 `daemon_health`（自报健康，包括 uptime、活跃 runId 列表、checkpointer 和 workspace 状态）。两个周期错开，意味着后端要连续错过两个心跳窗口才会判定一个 Runner 失联——这给了短暂 GC 停顿、磁盘抖动一点容错余量，不会因为一次抖动就误杀一个正在跑的运行。

心跳和 daemon_health 消息由后端消费：后端收到后写入 events.db 的 `runner_health` / `surface_health` 表，用于调度与健康汇总。

## 断点恢复：checkpointer.sqlite

每个 Runner 进程在本地持有一个 `checkpointer.sqlite`。它存的是**执行恢复所需的最小状态**——不是对话历史，也不是事件日志，而是「这次运行跑到哪一步、下一步从哪继续」。这条线和后端的 backend.db / events.db 是物理隔离的：

- 后端的账本与事件日志是**对外的事实**，要被多个端读取；
- Runner 的 checkpointer 是**进程私有的执行状态**，只服务于「崩了之后能原地爬起来」。

把它放在 Runner 本地，是为了让恢复不依赖后端往返：进程重启后直接读本地 sqlite 即可续跑。

## 反思（reflect）会 fork 一条新线程

当一次运行进入反思模式，Runner 不会在原线程上原地改写，而是 fork 出一条新的线程标识 `reflect:<threadId>`。这样做有两个后果：

1. 反思产生的中间状态不污染原对话线程的 checkpoint；
2. 反思线程被显式标记，便于在事件流和恢复逻辑里区分「这是主线运行」还是「这是一次反思分叉」。

另外，进入反思时 `surfaceContext` 会被**删除**——反思是 Agent 对自身的内省，不应该继承「这次是从 Web 来的还是从飞书来的」这种端上下文，否则反思产物可能错误地携带端语义。

## continue() 路径：预加载对话上下文

当 `start` 消息携带 `preloadedMessages`（非空数组）时，`hasPreloaded` 被置为 `true`。此时 Runner 不会调用 `agent.run(spec.input)`，而是调用 `agent.continue()`——跳过追加空 user message 的步骤，直接基于已预加载的对话上下文继续执行。

这条路径服务于「恢复一个已有对话的运行」：后端已经通过 `broadcastMessage()` 将对话投影到 checkpointer，Runner 只需加载后继续，不需要再插入一条空输入。

## 它不负责什么

明确地划清边界，能避免把对话语义泄漏进执行层：

- **不写对话账本**：Runner 只产出 `message` 事件，写账本是后端「会话投影」的职责。
- **不懂飞书去重**：`canSkipFinalLedgerText` 那套逻辑在飞书适配器里，Runner 不感知。
- **不决定对话可见性**：哪些事件对人可见，是投影那一层的判断。

## 关联页面

- [Runner 协议](runner-protocol.md)
- [Agent 文件系统](agent-file-system.md)
- [会话投影](../backend/conversation-projection.md)
- [事实与投影](../foundations/facts-and-projections.md)
