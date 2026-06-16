---
id: runtime.plugin
title: 运行时插件机制
status: current
owners: architecture
last_verified_against_code: 2026-06-16
summary: "插件是往 Framework 运行循环里挂行为的标准方式。一个插件就是一个带名字、带一组钩子、可选带工具的对象；createAgent 收下所有插件，由 createPluginRunner 在循环的各个节点按顺序触发它们的钩子。记忆、技能、防早停都是用这套机制实现的，循环本体不需要知道它们的存在。"
depends_on:
  - runtime.framework
used_by:
  - harness.harness
  - plugins.fs-memory
  - plugins.progressive-skill
  - plugins.task-guard
---

# 运行时插件机制

插件是往 Framework 运行循环里挂行为的标准方式。一个插件就是一个带名字、带一组钩子、可选带工具的对象；createAgent 收下所有插件，由 createPluginRunner 在循环的各个节点按顺序触发它们的钩子。记忆、技能、防早停都是用这套机制实现的，循环本体不需要知道它们的存在。

## Plugin 的形状

插件接口很小（packages/framework/src/plugin.ts）：

```ts
export interface Plugin {
  readonly name: string;
  readonly hooks: PluginHooks;
  readonly tools?: readonly Tool[];
}
```

三件事：一个 `name`、一组 `hooks`、可选地贡献一批 `tools`。工具会和钩子一起被注入运行时，因此一个插件既能「在节点上插手」（钩子），也能「给 Agent 新增能力」（工具）。

## 可挂的钩子

`PluginHooks` 对应 runLoop 的关键节点：

| 钩子 | 触发时机 | 典型用途 |
|------|----------|----------|
| `beforeRun` | 收到用户消息、进入循环前 | 预置待办计划 |
| `beforeModel` | 每次模型调用前 | 改写/注入消息（记忆、技能索引就挂这里） |
| `afterModel` | 每次模型调用后 | 观测、记账 |
| `beforeTool` | 工具执行前 | 可跳过或改写入参 |
| `afterTool` | 工具执行后 | 处理结果 |
| `beforeStop` | 循环准备停下前 | 否决停止、强制继续（防早停挂这里） |

## 注册与触发

插件通过 `AgentConfig.plugins` 传给 `createAgent`。内部由 `createPluginRunner` 把同名钩子收集起来，在对应节点**按顺序**依次触发。这意味着多个插件可以挂同一个钩子，它们的效果会按注册顺序叠加——比如 `beforeModel` 上既有记忆注入又有技能索引注入，两者先后拼进系统提示。

`beforeStop` 比较特殊：它能返回「继续」的决定来否决停止，但这种强制继续受 Framework 的 `maxForceContinues`（默认 3）约束，不会无限循环。

## 关联页面

- [Framework 运行循环](framework.md)
- [Harness 默认装配](../harness/harness.md)
- [文件型记忆](../plugins/fs-memory.md)
- [渐进式技能](../plugins/progressive-skill.md)
- [防早停任务守卫](../plugins/task-guard.md)
