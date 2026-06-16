---
id: plugins.task-guard
title: 防早停任务守卫
status: current
owners: architecture
last_verified_against_code: 2026-06-16
summary: "防早停任务守卫（taskGuardPlugin）专治 Agent「活没干完就想收工」。它挂在 beforeStop 钩子上：当 Agent 准备停下时，守卫检查是否还有未解决的工具错误、是否还有未完成的待办步骤；只要有，就否决停止、返回「继续」并附上原因。这种强制继续受 Framework 的 maxForceContinues（默认 3）约束，不会无限续命。"
depends_on:
  - runtime.framework
  - runtime.plugin
used_by:
---

# 防早停任务守卫

防早停任务守卫（taskGuardPlugin）专治 Agent「活没干完就想收工」。它挂在 beforeStop 钩子上：当 Agent 准备停下时，守卫检查是否还有未解决的工具错误、是否还有未完成的待办步骤；只要有，就否决停止、返回「继续」并附上原因。这种强制继续受 Framework 的 maxForceContinues（默认 3）约束，不会无限续命。

## 挂载点：beforeStop

守卫的逻辑全部发生在 `beforeStop`（packages/plugin-task-guard/src/task-guard.ts）。这个钩子在循环准备停下前触发，守卫可以在这里返回一个「继续」的决定，从而否决本次停止。

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

## 关联页面

- [Framework 运行循环](../runtime/framework.md)
- [运行时插件机制](../runtime/plugin.md)
