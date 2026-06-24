---
id: harness.harness
title: Harness 默认装配
status: current
owners: architecture
last_verified_against_code: 2026-06-16
summary: "Harness 把 Framework 这套底座装配成一个「开箱即用」的通用 Agent。它的入口是 createGenericAgent：在裸 Framework 之上，预置一组默认工具（基于 AgentFS 的 Read/Write/Edit，加上带工作区沙箱的 bash/glob/grep）和一组默认插件（文件型记忆、渐进式技能、task-guard守卫），让上层不必每次都手工拼装。"
depends_on:
  - runtime.framework
  - runtime.plugin
  - runtime.context-manager
  - runner.agent-file-system
used_by:
---

# Harness 默认装配

Harness 把 Framework 这套底座装配成一个「开箱即用」的通用 Agent。它的入口是 createGenericAgent：在裸 Framework 之上，预置一组默认工具（基于 AgentFS 的 Read/Write/Edit，加上带工作区沙箱的 bash/glob/grep）和一组默认插件（文件型记忆、渐进式技能、task-guard守卫），让上层不必每次都手工拼装。

## 入口：createGenericAgent

```ts
createGenericAgent(opts: GenericAgentOptions): Promise<Agent>
```

它做的事可以概括成「在 Framework 上铺一层有主张的默认值」：Framework 本身不假设你要哪些工具、挂哪些插件；Harness 替最常见的「通用助理」场景做了这些选择。

### GenericAgentOptions

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `workspace` | `AgentFsHandle` | 是 | Agent 文件系统句柄，提供虚拟文件视图 |
| `model` | `ChatModel` | 是 | 预构造的 ChatModel 实例（由调用方选适配器） |
| `threadId?` | `string` | 否 | 线程标识。相同 threadId 复用 checkpointer 历史。默认随机 uuid |
| `permissionMode?` | `"ask" \| "auto" \| "deny"` | 否 | 权限模式。默认 `"ask"` |
| `logger?` | `Logger` | 否 | 可注入的 Logger。默认 `consoleLogger()` |
| `checkpointer?` | `Checkpointer \| "memory" \| "sqlite"` | 否 | Checkpointer 实例或别名。默认 sqlite |
| `checkpointerDb?` | `Database` | 否 | 当 checkpointer 为 sqlite 时，使用此 Database 实例而非默认工作区文件 |
| `messages?` | `Message[]` | 否 | 预载消息以引导线程初始状态。传入后绕过 checkpointer.load() |
| `extraPlugins?` | `readonly Plugin[]` | 否 | 额外用户定义插件。与默认合并；重名则 fast-fail |
| `extraTools?` | `readonly Tool[]` | 否 | 额外用户定义工具。与默认合并；重名则 fast-fail |

## 默认工具

| 工具 | 来源 | 说明 |
|------|------|------|
| `Read` / `Write` / `Edit` | `@my-agent-team/tools-common` — `createReadToolForWorkspace(ws)`, `createWriteToolForWorkspace(ws)`, `createEditToolForWorkspace(ws)` | 走 AgentFS 的文件读写编辑 |
| `bash` / `glob` / `grep` | `@my-agent-team/tools-common` — `withWorkspace(bashTool, sandbox)`, `withWorkspace(grepTool, sandbox)`, `withWorkspace(globTool, sandbox)` | 带工作区沙箱（workspace root）约束的命令与检索 |

所有默认工具从 `@my-agent-team/tools-common` 导入。bash 等工具被显式包进工作区沙箱（`withWorkspace`），避免 Agent 触碰沙箱之外的真实文件系统——这是执行层安全的一道边界。

## 默认插件

Harness 默认装上三个插件，正好覆盖「记得住、学得会、不早停」：

```ts
fsMemoryPlugin({ ws, root: "/memory/" }),       // 长期记忆，挂在 shared 域
progressiveSkillPlugin({                        // 渐进式技能，挂在 private 域
  ws,
  root: "/skills/",
  posixSkillRoot: `${workspace.privateRoot}/skills`,
}),
taskGuardPlugin({ model }),                     // task-guard守卫
```

- `/memory/` 映射到 **shared** 域：记忆跨运行可见。
- `/skills/` 映射到 **private** 域（`/skills/*` 实际别名到 `/private/skills/*`）：技能是 Agent 私有的。

插件从各自的包导入：`@my-agent-team/plugin-fs-memory`、`@my-agent-team/plugin-progressive-skill`、`@my-agent-team/plugin-task-guard`。

## 上下文管理器：默认透传

`createGenericAgent` 不覆盖 `contextManager`，因此沿用 Framework 的默认值 `passthroughContextManager()`——通用 Agent 当前**不裁剪历史**，消息原样喂给模型。滑动窗口、token 预算、摘要压缩等实现都已就绪（见[上下文管理器](../runtime/context-manager.md)），但要生效需调用方显式传入；把哪种提为默认属于[未来工作](../roadmap/future-work.md)。

## 其他导出

除 `createGenericAgent` 和 `GenericAgentOptions` 外，harness 包还导出：

| 导出 | 说明 |
|------|------|
| `BOOTSTRAP_TEMPLATE` | Genesis 引导模板字符串。Agent 首次运行时若工作区为空，将其作为系统提示注入，引导 Agent 完成「出生」对话 |
| `bootstrap(fs, logger, displayRoot?)` | 读取工作区文件（SOUL/USER/TOOLS/AGENTS/日志），组装系统提示。若工作区为空则返回 `BOOTSTRAP_TEMPLATE` |
| `reflectionGuidance()` | 反射引导文本。在主线任务循环结束后注入，让 Agent 自行决定把哪些观察写到记忆文件里 |
| `verificationGuidance()` | 冷审查验证引导文本。注入到分叉 Agent 中，让冷审阅者重新打开产物并逐项验证计划是否真的完成 |

## 为什么要有 Harness 这一层

Framework 追求「最小且无主张」，Harness 追求「最常用且能直接跑」。把默认装配单独抽一层，好处是：换默认工具集、调插件组合，只动 Harness，不动 Framework 内核；而需要极致定制的调用方，仍然可以绕过 Harness 直接用 Framework。

## 关联页面

- [Framework 运行循环](../runtime/framework.md)
- [上下文管理器](../runtime/context-manager.md)
- [运行时插件机制](../runtime/plugin.md)
- [Agent 文件系统](../runner/agent-file-system.md)
