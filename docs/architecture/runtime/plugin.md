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

`PluginHooks` 对应 runLoop 的关键节点。钩子签名不是统一的——各自有各自的参数和返回值语义：

### TRANSFORMER 钩子（返回消息，替换线程消息）

| 钩子 | 签名 | 触发时机 | 返回 |
|------|------|----------|------|
| `beforeRun` | `(ctx: HookContext, messages) => Message[] \| Promise<Message[]>` | 收到用户消息、进入循环前 | 返回的 `Message[]` 替换 `thread.messages`（如果引用等同则不替换） |
| `beforeModel` | `(ctx: HookContext, messages) => Message[] \| Promise<Message[]>` | 每次模型调用前 | 返回的 `Message[]` 作为本次模型调用的实际入参（不持久修改线程消息）；链式：每个插件的返回值传给下一个插件 |

`beforeRun` 的 Transformer 特殊约定：如果插件返回的数组引用不等于 `thread.messages`，**线程消息会被整批替换**为新数组（`create-agent.ts` L631-636）。这意味着 `beforeRun` 可以追加消息（如待办指南）、注入系统提示，甚至截断历史。

### 特殊返回钩子

| 钩子 | 签名 | 触发时机 | 返回 |
|------|------|----------|------|
| `beforeTool` | `(ctx: HookContext, call: ToolUseBlock, messages) => ...` | 工具执行前 | `{ skip?, input?, result?, isError? } \| undefined` -- `skip: true` 跳过执行并用 `result` 作为伪造结果；`input` 覆写入参 |
| `beforeStop` | `(ctx: HookContext, messages) => StopDecision \| undefined \| Promise<...>` | 循环准备停下前 | `{ continue: true; reason: string }` 否决停止强制继续；`{ continue: false }` 或 `undefined` 放行 |

`beforeStop` 是唯一能「否定」循环停止动作的钩子。当多个插件挂 `beforeStop` 时，所有 `continue: true` 的 `reason` 会被合并为一条用户消息注入。

### OBSERVER 钩子（无返回值，纯副作用）

| 钩子 | 签名 | 触发时机 | 典型用途 |
|------|------|----------|----------|
| `afterModel` | `(ctx: HookContext, messages) => void \| Promise<void>` | 每次模型调用后 | 观测、记账 |
| `afterTool` | `(ctx: HookContext, call: ToolUseBlock, result: ToolResultBlock, messages) => void \| Promise<void>` | 工具执行后 | 处理结果、副作用 |

Observers 不能改变消息流——它们只能读取状态、发事件（通过 `ctx.emit`）、或执行副作用。

## StopDecision 类型

`beforeStop` 钩子的返回类型，定义在 `packages/framework/src/plugin.ts`：

```ts
type StopDecision = { continue: true; reason: string } | { continue: false };
```

- `{ continue: true, reason }` -- 否决停止，`reason` 作为新的 user 消息注入线程，促使 Agent 继续
- `{ continue: false }` -- 放行，允许循环结束
- 返回 `undefined` 等价于 `{ continue: false }`

## HookContext 接口

每个钩子函数都接收一个 `ctx: HookContext`，定义在 `packages/framework/src/plugin.ts`：

```ts
interface HookContext {
  threadId: string;              // 当前线程 ID
  signal?: AbortSignal;          // 运行中止信号
  logger: Logger;                // 日志器
  checkpointer: Checkpointer;    // 断点存取
  contextManager: ContextManager;// 上下文管理器（用于上下文窗口整形等）
  emit?(event: AgentEvent): void;// 可选事件发射器，插件可通过它推送 AgentEvent
}
```

`emit` 仅在携带事件（如 `todo_update`）时使用——不暴露模型，不改变消息流。框架在每次钩子触发前注入最新引用。

## 注册与触发

插件通过 `AgentConfig.plugins` 传给 `createAgent`。内部由 `createPluginRunner` 把同名钩子收集起来，在对应节点**按顺序**依次触发。这意味着多个插件可以挂同一个钩子，它们的效果会按注册顺序叠加——比如 `beforeModel` 上既有记忆注入又有技能索引注入，两者先后拼进系统提示。

`beforeStop` 比较特殊：它能返回「继续」的决定来否决停止，但这种强制继续受 Framework 的 `maxForceContinues`（默认 3）约束，不会无限循环。

## 关联页面

- [Framework 运行循环](framework.md)
- [Harness 默认装配](../harness/harness.md)
- [文件型记忆](../plugins/fs-memory.md)
- [渐进式技能](../plugins/progressive-skill.md)
- [防早停任务守卫](../plugins/task-guard.md)
