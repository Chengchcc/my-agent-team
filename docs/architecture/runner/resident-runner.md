---
id: runner.resident-runner
title: 常驻 Runner
status: current
owners: architecture
last_verified_against_code: 2026-06-22
summary: "常驻 Runner（RunnerDaemon）是执行 Agent 的统一进程。每个 Agent 一个独立进程，本地维护 checkpointer.sqlite 做 recovery，通过 heartbeat + daemon_health 两个定时器向后端报活。它不懂对话语义——只跑、只上报事件。preloadedMessages 由后端 buildPreloadedMessages 从 ledger 直接构建。"
depends_on:
  - runner.runner-protocol
  - runner.agent-file-system
used_by:
  - backend.run-supervisor
---

# 常驻 Runner

常驻 Runner 是 `RunnerDaemon` 类的一个实例。每个 Agent 一个进程。它做三件事：接收后端的 `start` 指令、跑 Agent、把事件上报回去。本地有个 `checkpointer.sqlite` 做 recovery。有两个定时器向后端报活。它不知道对话语义——不知道什么是 [ledger](../conversation/ledger.md)、不知道 [Lark](../surfaces/lark-adapter.md) 去重——只管跑。

## 为什么常驻

一次 Agent 运行可能很久：多轮 tool call、reflect、被中断又恢复。每次请求起新进程的话，skill 加载、memory 映射、model client 全要重建，recovery 也会很脆弱。所以一个 Agent 一个长活进程：第一次被需要时拉起，之后一直等着下一次 `start`。

进程和 Agent 一一对应，state（checkpointer、surfaceContext）天然按 Agent 隔离。

## 保活

两个定时器：

- `#heartbeatTimer`：每 5000ms 向后端发 `heartbeat`（按活跃 runId 逐条发）
- `#daemonHealthTimer`：每 10000ms 发 `daemon_health`（uptime、活跃 runId 列表、checkpointer 和 workspace 状态）

两个周期错开。后端需要连续错过两个心跳窗口才会判失联——短暂 GC 停顿或磁盘抖动不会误杀。

## Recovery：checkpointer.sqlite

每个 Runner 进程本地有一个 `checkpointer.sqlite`。它存的是"跑到哪一步、下一步从哪继续"——不是对话历史，不是 event log。

和后端 backend.db / events.db 物理隔离。后端存的是对外事实，多端读取；Runner checkpointer 是进程私有的 execution state，只服务"崩了能原地爬起来"。放本地是为了 recovery 不依赖后端往返：进程重启直接读本地 sqlite。

## reflect：fork 新线程

进入 reflect 模式时，Runner 不原地改写，而是 fork 一条 `reflect:<threadId>` 线程。效果：

1. reflect 中间 state 不污染原线程 checkpoint
2. 线程被显式标记，事件流和 recovery 里能区分"主线"和"reflect 分叉"

进入 reflect 时 `surfaceContext` 会被删掉——reflect 是 Agent 对自身的内省，不应继承"这次从 Web 还是 Lark 来的"这种端上下文。

## continue()：预加载对话上下文

`start` 消息带 `preloadedMessages` 时，Runner 调 `agent.continue()` 而不是 `agent.run(spec.input)`。跳过追加空 user message，直接基于已有对话上下文继续。

`preloadedMessages` 由后端 `buildPreloadedMessages` 从 ledger 直接构建，在 `forkRun` 时传入。

## 它不负责什么

- **不写 ledger**：Runner 只产出 `message` 事件。写 ledger 是后端 `onRunMessage → appendAssistantMessage` 的事。
- **不懂 Lark 去重**：`canSkipFinalLedgerText` 在 Lark adapter 里，Runner 不感知。
- **不决定对话可见性**：哪些事件对人可见，是 projection 层的判断。

## 关联页面

- [Runner 协议](runner-protocol.md)
- [Agent 文件系统](agent-file-system.md)
- [会话投影](../backend/conversation-projection.md)
- [事实与投影](../foundations/facts-and-projections.md)
