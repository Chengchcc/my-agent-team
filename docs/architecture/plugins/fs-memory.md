---
id: plugins.fs-memory
title: 文件型记忆插件
status: current
owners: architecture
last_verified_against_code: 2026-06-16
summary: "文件型记忆插件（fsMemoryPlugin）让 Agent 拥有「跨运行记得住」的长期记忆。它把记忆落在 AgentFS 的 /memory/ 路径下（shared 域），通过 beforeModel 钩子在每次模型调用前把相关记忆注入系统提示，并向 Agent 暴露 memory_read / memory_write / memory_search 这组工具来主动读写。"
depends_on:
  - runtime.plugin
used_by:
---

# 文件型记忆插件

文件型记忆插件（fsMemoryPlugin）让 Agent 拥有「跨运行记得住」的长期记忆。它把记忆落在 AgentFS 的 /memory/ 路径下（shared 域），通过 beforeModel 钩子在每次模型调用前把相关记忆注入系统提示，并向 Agent 暴露 memory_read / memory_write / memory_search 这组工具来主动读写。

## 记忆放在哪

记忆文件落在 AgentFS 的 `/memory/` 前缀下，该前缀映射到 **shared** 域。shared 意味着这块数据不绑定单次运行——同一个 Agent 在不同运行、不同对话里都能看到自己之前记下的东西。这正是「长期记忆」该有的生命周期。

插件在首次 `beforeModel` 调用时会自动创建 `/memory/` 目录和 `/memory/facts/` 子目录（`fs-memory.ts` 第 33-34 行）。`memory_write` 工具将记忆写成带 YAML frontmatter 的独立 fact 文件（`frontmatter.ts`），落在 `/memory/facts/` 下，文件名格式为 `<timestamp>-<slug>.md`。

## 怎么用上记忆：beforeModel 注入

插件挂在 `beforeModel` 钩子上。每次即将调用模型前，它读取相关记忆内容并拼进系统提示，使模型「带着记忆」去思考。注入发生在模型调用前、对 Agent 透明——Agent 不需要每轮都显式去查记忆，相关上下文已经在提示里。

## 主动读写：三个工具

除了被动注入，插件还给 Agent 三个工具去主动操作记忆：

| 工具 | 作用 |
|------|------|
| `memory_read` | 读取指定记忆 |
| `memory_write` | 写入/更新记忆 |
| `memory_search` | 检索记忆 |

被动注入解决自动带上，主动工具解决刻意存取。两者互补。

`memory_read` 在不传 `path` 参数时，默认读取 `/memory/MEMORY.md`（`memory-read.ts` 第 14 行）。传入 `path` 则可读取指定 fact 文件。

## 关联页面

- [运行时插件机制](../runtime/plugin.md)
- [Harness 默认装配](../harness/harness.md)
