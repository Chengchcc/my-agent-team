# @my-agent-team/plugin-task-guard

一个 framework 插件，让 agent 在动手前先列计划、过程中追踪进度、想收尾时被确定性地校验是否真的做完。它把「规划 → 跟踪 → 把关」三件事挂到 framework 的钩子上。

## 为什么需要它 / 解决什么问题

agent 经常半途而废：要么没规划就乱做，要么做了一半就宣布完成，要么某个工具报了错却假装没看见直接收尾。这些都不是模型能力问题，而是缺一个外部的纪律约束。

这个插件把纪律做成确定性的关卡，而不是再求模型自觉。它在 run 开始时生成一份冻结的待办计划，在每一轮把进度注入系统提示让模型时刻看到，并在模型试图停下时做几道确定性检查——有未处理的工具错误，或还有未完成的步骤，就否决停止、把原因作为输入塞回去逼它继续。

职责边界：这里只做热层（hot-layer）的确定性把关，不调用 LLM 做语义判断。真正「做得对不对」的语义复审（cold review）在 runner 层用 `agent.fork()` 另起一轮完成，不属于本插件。

## 核心概念

插件通过 framework 的三个钩子工作（钩子名以 framework 的 `PluginHooks` 类型为准）：

- `beforeRun` —— 每次 run 在用户消息入队后触发一次。它用注入的模型生成一份有序步骤，转成冻结的 todo 列表，并把计划指引作为一条 user 消息追加进去。任务过于琐碎或生成失败则原样放行（fail-open）。
- `beforeModel` —— 每一轮模型调用前，把当前 todo 进度以 `<todo>` 块注入系统提示。
- `beforeStop` —— 模型不再调用工具、循环将要结束时触发。先查未处理的工具错误，再跑用户传入的额外校验器，最后查是否还有未完成步骤；任意一项命中就返回 `{ continue: true, reason }` 否决停止。

待办项结构是 `Todo = { step: string; status: TodoStatus }`，状态枚举 `TodoStatus` 只有三个值：`"pending" | "in_progress" | "done"`。

插件还贡献一个 `todo_write` 工具，模型用它翻转步骤状态。关键纪律：这个工具只能更新已有步骤的状态（且 schema 只允许置为 `in_progress` 或 `done`），不能增删步骤——计划一旦冻结就不可改。每次更新都会通过钩子上下文的 `emit` 推一个 `todo_update` 事件，供 Web UI 展示。

导出的 `unresolvedToolErrors` 是上面用到的确定性校验器，也单独导出供复用；`StopValidator` 是额外校验器的类型。

## 怎么用

```ts
import { taskGuardPlugin } from "@my-agent-team/plugin-task-guard";
import type { ChatModel } from "@my-agent-team/core";

declare const model: ChatModel; // 由 harness 通过闭包注入，绝不来自 HookContext

const plugin = taskGuardPlugin({
  model,
  plan: true,          // beforeRun 生成计划，默认 true
  showProgress: true,  // beforeModel 注入进度，默认 true
  // extraValidators: [...]  // 可选的额外确定性校验器
});

// 把 plugin 注册进 framework 的 agent 配置即可
```

依赖关系：依赖 `@my-agent-team/core`（模型与消息类型）和 `@my-agent-team/framework`（插件与 `StopDecision` 类型）。包内被 `harness` 使用。
