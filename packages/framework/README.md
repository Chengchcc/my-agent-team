# @my-agent-team/framework

把 `core` 那个极简的 `run()` 升级成一个有状态、可组合、可观测的 agent。一句 `createAgent()` 就能把模型、工具、插件、检查点、上下文管理拼成一个能流式产出事件、支持续跑/恢复/分叉的 `Agent`。

## 为什么需要它

`core` 给了你一个能跑的循环，但只是个起点。真实的 agent 还需要：把过长的上下文裁剪到能塞进模型；把对话状态持久化下来以便崩溃恢复；在调模型前后、调工具前后插入自定义逻辑；把内部发生的事以事件流的形式吐给上层 UI；以及在工具需要人类确认时把整个运行暂停下来、等批准后再继续。这些如果每个上层应用各写一遍，既重复又容易写错。

`framework` 的职责就是把这些"运行一个 agent 该有的工程能力"收拢到一处，并以可插拔的形式提供：检查点、上下文管理器、插件都是接口，你可以换实现或叠加，而循环骨架本身保持稳定。它不规定任何具体的工具或提示词——那是 `harness` 和各 `plugin-*` 的事。

## 核心概念

**createAgent 与 Agent。** `createAgent(config)` 是 **async** 的，返回 `Promise<Agent>`——因为它要先把检查点器准备好（默认 `inMemoryCheckpointer()`）、校验它、再 `load` 或 seed 初始消息，然后才交出 agent。`AgentConfig` 里 `model` 必填，其余可选：`tools`、`systemPrompt`、`plugins`、`checkpointer`、`contextManager`、`logger`、`threadId`、以及用于预置消息的 `messages`。

返回的 `Agent` 有四个动作，都是异步生成器，逐个 yield `AgentEvent`：`run(input, opts?)` 追加一条 user 消息并跑循环；`continue(opts?)` 不追加新消息、直接从检查点里已有的消息续跑（要求历史里已有 user 消息，否则报错）；`resume(command, opts?)` 消费一次挂起的中断后继续；`fork(messages?, id?)` 用同样的配置复制出一个新 agent（必须用不同的 threadId）。同一个 agent 同时只能跑一个运行，并发请用 `fork()`。

**AgentEvent。** 这是 agent 对外的唯一观测面，是个带 `type` 的联合：`message`（一条完整消息）、`text_delta` / `reasoning_delta`（流式增量，仅当 `opts.stream` 为真时产生文本增量）、`tool_start` / `tool_end`、`interrupted`、`error`、`todo_update`，以及两类固化的逐次度量 `llm_call`（每次调模型的 usage、延迟、首 token 时间、stopReason）和 `tool_call`（每次工具调用的延迟与是否出错）。

**Tool（来自 core）与 run 循环。** 每个 step 的骨架是：上下文管理器 `shape` → 插件 `beforeModel` → `model.stream` → 拼装内容块 → `afterModel` → 若有工具调用则逐个执行（`beforeTool` → `execute` → `afterTool`），若无工具调用则走 `beforeStop` 决定停或强制继续。默认 `maxSteps` 为 32。

**插件与 hook。** 插件用 `definePlugin({ name, hooks, tools? })` 定义。`PluginHooks` 可实现这几个子集：`beforeRun`（每次运行开头一次，可改写消息）、`beforeModel`（可改写发给模型的消息）、`afterModel`、`beforeTool`（可跳过某次调用或改写其入参）、`afterTool`、`beforeStop`（返回 `StopDecision` 否决停止、用 reason 作为新输入强制续跑，受 `maxForceContinues` 约束，默认 3）。所有 hook 按注册顺序触发，某个 hook 抛错只会被记日志并跳过，绝不会中断整个运行。插件还能通过 `HookContext.emit` 推送 `AgentEvent`（如 `todo_update`），以及通过 `tools` 字段贡献工具。`validatePlugins` 会合并插件与配置里的工具并在重名时报错。

**上下文管理器。** 接口只有一个 `shape(ctx, messages)`。内置若干实现：`passthroughContextManager`（原样返回）、`slidingWindowContextManager`（保留最近 N 轮）、`summarizingContextManager`（摘要压缩较旧消息）、`tokenBudgetContextManager`（裁到 token 预算内）、`toolResultTruncator`（限制每条工具结果的字符数）。用 `pipeContextManagers(...)` 串成流水线，前一个的输出喂给后一个。

**检查点器与中断。** `Checkpointer` 接口必须实现 `load`/`save`，可选实现成对的 `saveInterrupt`/`consumeInterrupt` 和 `appendEvent`/`readEvents`（`validateCheckpointer` 会强制这两组能力要么都实现要么都不实现）。内置 `inMemoryCheckpointer()`、`fileCheckpointer({ dir })`、`sqliteCheckpointer({ db })` 三种实现。中断机制：工具在 `execute` 里 `throw new InterruptSignal(reason, meta?)`，框架会保存状态并 emit 一个 `interrupted` 事件；人类决定后调 `agent.resume({ approved, message? })`，`resume` 消费中断并继续循环。

辅助导出还有 `repairToolPairs`（修复历史里落单的 tool_use/tool_result 配对，便于重放）、`consoleLogger`/`noopLogger`、以及 `Thread` 类型（`{ id, messages }`，agent 的实时消息状态句柄）。

## 怎么用

```ts
import {
  createAgent,
  pipeContextManagers,
  slidingWindowContextManager,
  toolResultTruncator,
  sqliteCheckpointer,
} from "@my-agent-team/framework";
import type { ChatModel, Tool } from "@my-agent-team/core";

declare const model: ChatModel;
declare const tools: Tool[];

// createAgent 是 async 的，记得 await
const agent = await createAgent({
  model,
  tools,
  checkpointer: sqliteCheckpointer({ db: "state.db" }),
  contextManager: pipeContextManagers(
    slidingWindowContextManager({ maxTurns: 50 }),
    toolResultTruncator({ maxCharsPerResult: 8000 }),
  ),
});

for await (const event of agent.run("部署应用", { stream: true })) {
  if (event.type === "text_delta") process.stdout.write(event.payload.text);
}
```

## 依赖关系

`framework` 依赖 `core`。它是上层应用的基座，被 `harness`、`event-log`、`runner-protocol`、`runner-daemon`、各 `plugin-*`（`plugin-fs-memory`、`plugin-progressive-skill`、`plugin-task-guard`）以及 `apps/backend` 依赖。
