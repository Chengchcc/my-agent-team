---
id: plugins.task-guard
title: task-guard plugin
status: current
owners: architecture
last_verified_against_code: 2026-06-16
summary: "task-guard plugin（taskGuardPlugin）专治 Agent「活没干完就想收工」。它挂在 beforeStop 钩子上：当 Agent 准备停下时，守卫检查是否还有未解决的工具错误、是否还有未完成的待办步骤；只要有，就否决停止、返回「继续」并附上原因。这种强制继续受 Framework 的 maxForceContinues（默认 3）约束，不会无限续命。"
depends_on:
  - runtime.framework
  - runtime.plugin
used_by:
---

# task-guard plugin

task-guard plugin（taskGuardPlugin）专治 Agent「活没干完就想收工」。它挂在 beforeStop 钩子上：当 Agent 准备停下时，守卫检查是否还有未解决的工具错误、是否还有未完成的待办步骤；只要有，就否决停止、返回「继续」并附上原因。这种强制继续受 Framework 的 maxForceContinues（默认 3）约束，不会无限续命。

## 挂载点：四个钩子 + 一个工具

task-guard plugin不止挂 `beforeStop`——它覆盖了运行循环的四个节点，并贡献一个工具：

| 钩子/工具 | 触发时机 | 做了什么 |
|-----------|----------|----------|
| `beforeRun` | 收到用户消息、进入循环前 | 调用 LLM 把任务拆成待办步骤（`generatePlan`），冻结为 `Todo[]` 列表写入 `todos` Map；同时把计划指南作为新 user 消息追加到消息列表末尾，并发出初始 `todo_update` 事件 |
| `beforeModel` | 每次模型调用前 | 把当前待办进度渲染成 `- [ ]` / `- [>]` / `- [x]` 格式，注入系统提示中 `<todo>...</todo>` 标签内，让模型每次调用都能看见进度 |
| `todo_write`（工具） | 模型调用工具时 | 模型标记步骤为 `in_progress` 或 `done`。只允许修改状态，不允许增删步骤。每次更新后发出 `todo_update` 事件 |
| `beforeStop` | 循环准备停下前 | 守卫逻辑：检查未解决的错误 + 未完成的待办步骤。有问题就返回 `continue: true` 否决停止 |

**计划生成**（`beforeRun`）、**进度注入**（`beforeModel`）、**进度更新**（`todo_write`）和**停止裁决**（`beforeStop`）分属四个不同阶段，不是全挤在 `beforeStop` 里。

## 两类「不该停」的信号

守卫主要看两件事：

1. **未解决的工具错误**——如果上一轮工具调用出错且没有被处理，贸然停下会留下烂摊子。
2. **未完成的待办步骤**——这是最常见的早停。核心判断是：

```ts
const left = list.filter((t) => t.status !== "done");
if (left.length > 0) {
  return {
    continue: true,
    reason: `The following todo steps are still pending...`,
  };
}
```

只要待办列表里还有非 `done` 的项，守卫就返回 `continue: true`，并把「还有哪些没做完」作为理由回给循环，促使 Agent 继续干。

## 闸门：maxForceContinues

强制继续不是无限的。Framework 层有 `maxForceContinues`（默认 **3**）限制守卫能强推多少次继续。这是一个有意的平衡：

- 给 Agent 有限次机会把活真正干完，对抗「过早收尾」；
- 又不至于在某种死循环里被守卫无限拽回来，最终还是会放它停。

## 扩展验证器：extraValidators

`TaskGuardOptions.extraValidators` 允许调用方注入额外的 `StopValidator` 函数。在 `beforeStop` 触发时，这些验证器在 `unresolvedToolErrors` 之后、todo 完成检查之前依次运行：

```ts
type StopValidator = (
  messages: readonly Message[],
) => StopDecision | undefined | Promise<StopDecision | undefined>;
```

- 任何一个验证器返回 `{ continue: true, reason }` 就会否决停止
- 返回 `undefined` / `{ continue: false }` 表示放行，继续下一个验证器
- 验证器抛错时 fail-open（忽略，继续检查后续）
- 所有额外验证器和内置检查合并为一个链：**工具错误 → extraValidators → 待办完成**

典型用途：注入业务特定的停止条件，例如「项目状态报告是否已生成」或「变更是否已提交」，而不需要 fork 插件本体。

## 关联页面

- [Framework 运行循环](../runtime/framework.md)
- [运行时插件机制](../runtime/plugin.md)
