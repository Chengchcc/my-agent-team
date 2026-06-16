---
id: harness.harness
title: Harness 默认装配
status: current
owners: architecture
last_verified_against_code: 2026-06-16
summary: "Harness 把 Framework 这套底座装配成一个「开箱即用」的通用 Agent。它的入口是 createGenericAgent：在裸 Framework 之上，预置一组默认工具（基于 AgentFS 的 Read/Write/Edit，加上带工作区沙箱的 bash/glob/grep）和一组默认插件（文件型记忆、渐进式技能、防早停守卫），让上层不必每次都手工拼装。"
depends_on:
  - runtime.framework
  - runtime.plugin
  - runner.agent-file-system
used_by:
---

# Harness 默认装配

Harness 把 Framework 这套底座装配成一个「开箱即用」的通用 Agent。它的入口是 createGenericAgent：在裸 Framework 之上，预置一组默认工具（基于 AgentFS 的 Read/Write/Edit，加上带工作区沙箱的 bash/glob/grep）和一组默认插件（文件型记忆、渐进式技能、防早停守卫），让上层不必每次都手工拼装。

## 入口：createGenericAgent

```ts
createGenericAgent(opts: GenericAgentOptions): Promise<Agent>
```

它做的事可以概括成「在 Framework 上铺一层有主张的默认值」：Framework 本身不假设你要哪些工具、挂哪些插件；Harness 替最常见的「通用助理」场景做了这些选择。

## 默认工具

| 工具 | 说明 |
|------|------|
| `Read` / `Write` / `Edit` | 走 AgentFS 的文件读写编辑 |
| `bash` / `glob` / `grep` | 带工作区沙箱（workspace root）约束的命令与检索 |

bash 等工具被显式包进工作区根目录，避免 Agent 触碰沙箱之外的真实文件系统——这是执行层安全的一道边界。

## 默认插件

Harness 默认装上三个插件，正好覆盖「记得住、学得会、不早停」：

```ts
fsMemoryPlugin({ ws, root: "/memory/" }),       // 长期记忆，挂在 shared 域
progressiveSkillPlugin({ ... root: "/skills/" }) // 渐进式技能，挂在 private 域
taskGuardPlugin(...)                              // 防早停守卫
```

- `/memory/` 映射到 **shared** 域：记忆跨运行可见。
- `/skills/` 映射到 **private** 域（`/skills/*` 实际别名到 `/private/skills/*`）：技能是 Agent 私有的。

## 为什么要有 Harness 这一层

Framework 追求「最小且无主张」，Harness 追求「最常用且能直接跑」。把默认装配单独抽一层，好处是：换默认工具集、调插件组合，只动 Harness，不动 Framework 内核；而需要极致定制的调用方，仍然可以绕过 Harness 直接用 Framework。

## 关联页面

- [Framework 运行循环](../runtime/framework.md)
- [运行时插件机制](../runtime/plugin.md)
- [Agent 文件系统](../runner/agent-file-system.md)
