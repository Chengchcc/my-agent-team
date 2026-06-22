---
id: runtime.framework
title: Framework 运行循环
status: current
owners: architecture
last_verified_against_code: 2026-06-22
summary: "Framework 是 Agent 真正「思考—行动」的运行时核心。它的心脏是 runLoop：一个受 maxSteps 与 maxForceContinues 约束的循环，每一步可能调模型、可能调工具，并把过程拆成一串结构化 AgentEvent 往外吐。围绕循环还有一组生命周期钩子和一个 Checkpointer 接口，分别负责「在关键节点插手」和「断点存取」。"
depends_on:
  - runner.resident-runner
used_by:
  - runtime.plugin
  - plugins.task-guard
---

# Framework 运行循环

Framework 是 Agent 真正「思考—行动」的运行时核心。它的心脏是 runLoop：一个受 maxSteps 与 maxForceContinues 约束的循环，每一步可能调模型、可能调工具，并把过程拆成一串结构化 AgentEvent 往外吐。围绕循环还有一组生命周期钩子和一个 Checkpointer 接口，分别负责「在关键节点插手」和「断点存取」。

## runLoop：一步一步推进

`runLoop` 是驱动 Agent 的主循环。每一轮迭代里，Agent 要么向模型发起一次调用，要么执行一次工具调用，循环持续直到自然停止或触达上限。两个上限保护它不会失控：

- `maxSteps`，默认 **32**：一次运行最多推进多少步。
- `maxForceContinues`，默认 **3**：当 Agent 想要提前停下、但还有未完成的工作时，循环可以「强制再继续」的次数上限。这是对抗「过早收尾」的闸门——它给 Agent 有限次机会去把活干完，但又不会无限续命。

## AgentEvent：循环对外的唯一语言

循环内部发生的一切，都被翻译成一个判别联合 `AgentEvent` 往外发：

| 事件 | 含义 |
|------|------|
| `message` | 一条完整消息（被 Runner 上报后，由 Backend 的 `onRunMessage` [直写进账本](../conversation/ledger.md)，再由 `broadcastMessage` [扇出](../backend/conversation-projection.md)到前端） |
| `interrupted` | 运行被中断 |
| `error` | 运行出错 |
| `text_delta` | 文本流式增量 |
| `reasoning_delta` | 推理过程流式增量 |
| `tool_start` | 工具开始执行 |
| `tool_end` | 工具执行结束 |
| `todo_update` | 待办/计划更新 |
| `llm_call` | 一次模型调用 |
| `tool_call` | 一次工具调用 |

注意 `message` 与 `text_delta` 的分工，和 Runner 协议里 `event` 与 `delta` 的分工是一脉相承的：`message` 是事实候选，`*_delta` 是给实时渲染看的流。

## 生命周期钩子

围绕循环的关键节点，Framework 暴露一组钩子，让插件在不改循环本体的前提下插手：

- `beforeRun` — 运行开始前
- `beforeModel` / `afterModel` — 每次模型调用的前后
- `beforeTool` / `afterTool` — 每次工具调用的前后
- `beforeStop` — 循环准备停下前（防早停逻辑常挂在这里）

这套钩子是 task-guard、observability 等插件的接入点。

## Agent API：run / continue / fork / resume

Framework 返回的 `Agent` 对象暴露四种执行入口：

### run(input, opts?)

标准入口，追加用户消息后启动运行循环。

```ts
run(input: string, opts?: AgentRunOptions): AsyncIterable<AgentEvent>
```

### continue(opts?)

从断点消息恢复运行，**不追加**新的用户消息。适用于会话级触发场景：用户的输入已经由上层 `buildPreloadedMessages` 从[账本](../conversation/ledger.md)构建为 Message[] 注入到 `preloadedMessages` 中，`continue()` 直接拾取已有上下文继续执行。若无用户消息则抛错。

```ts
continue(opts?: AgentRunOptions): AsyncIterable<AgentEvent>
```

实现上，`continue()` 和 `run()` 共享同一运行逻辑——区别仅在于 `continue()` 不推送新 user message，且会在入口处校验线程中至少有一条 user 消息。

### fork(messages?, id?)

创建新的 `Agent` 实例，**共享**配置（model、systemPrompt、plugins、checkpointer）但拥有**独立**的消息线程。不复制历史时默认 `structuredClone` 当前消息；也可显式传入 `messages` 数组和可选的 `threadId`。

```ts
fork(messages?: Message[], id?: string): Agent
```

典型用途：在验证回合（cold-review）中用 fork 克隆一个 Agent，注入验证提示单独跑一轮，而原 Agent 保持原样。

### resume(command, opts?)

从中断恢复运行。`command` 使用 `ResumeCommand` 类型：

```ts
interface ResumeCommand {
  approved: boolean;   // 是否批准被中断的操作
  message?: string;    // 可选的附加消息（如拒绝原因）
}
```

恢复时框架会找到中断对应的占位 tool_result，替换为真实结果（`approved` 决定 `is_error` 字段），然后继续执行循环。

## Checkpointer 接口

断点能力被抽象成一个接口，由具体后端（如 Runner 本地的 checkpointer.sqlite）实现：

```ts
interface Checkpointer {
  load(...)            // 读取上次断点
  save(...)            // 保存正常推进的断点
  saveInterrupt(...)   // 保存「被中断」这一特殊状态
  consumeInterrupt(...)// 取出并清除中断状态（恢复时用）
}
```

`saveInterrupt` / `consumeInterrupt` 成对出现，专门服务于「中断—恢复」：中断时把状态封存，恢复时取出并清除，避免同一个中断被消费两次。

## 关联页面

- [常驻 Runner](../runner/resident-runner.md)
- [运行时插件](plugin.md)
- [防早停任务守卫](../plugins/task-guard.md)
- [运行编排器](../backend/run-supervisor.md)
- [对话账本](../conversation/ledger.md)
- [会话投影](../backend/conversation-projection.md)
