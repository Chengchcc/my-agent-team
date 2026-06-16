---
id: runtime.framework
title: Framework 运行循环
status: current
owners: architecture
last_verified_against_code: 2026-06-16
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
| `message` | 一条完整消息（会被上报、进而可能被投影到账本） |
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
