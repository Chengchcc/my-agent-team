---
id: plugins.memory
title: 记忆插件
status: current
owners: architecture
last_verified_against_code: 2026-07-22
summary: "记忆插件（memoryPlugin）让 Agent 拥有「跨运行记得住」的长期记忆。它把记忆落在 per-agent workspace 的 memory/ 路径下，通过 beforeModel 钩子注入 memory_summary.md 到系统提示，并向 Agent 暴露 memory_read / memory_retain / memory_search 工具。支持自动提取 pipeline（两阶段 LLM）。"
depends_on:
  - runtime.plugin
used_by:
---

# 记忆插件

记忆插件（memoryPlugin）让 Agent 拥有「跨运行记得住」的长期记忆。核心能力：被动注入（beforeRun）+ 主动工具（read/retain/search）+ 自动提取（afterModel pipeline）。

## 记忆放在哪

**Per-agent workspace**（`dataDir/agents/<agentId>/memory/`），不再是 shared workspace。

```text
memory/
├── memory_summary.md   ← Phase 2 输出，注入 system prompt
└── facts/
    ├── <ISO-TS>-<slug>.md
    └── ...
```

facts 文件带 YAML frontmatter（ts/title/tags/context）。

## 怎么用上记忆：beforeRun 注入

`beforeRun` 钩子读 `memory_summary.md`（mtime 缓存），写入 `MemoryKey` context。conversation-compose 的 `metaContext` 读取后以 `<memory>` XML 标签注入 system-reminder。

## 主动读写：三个工具

| 工具 | 作用 |
|------|------|
| `memory_read` | 读取记忆（不传 path → 读 memory_summary.md） |
| `memory_retain` | 批量写入 `{ items: [{ content, context?, tags? }] }` |
| `memory_search` | 多词 AND 搜索 + 时间过滤（`since: "7d"`） |

## 自动提取 pipeline

`afterModel` 钩子：

```
新消息 >= minMessagesForExtraction (5)?
    ↓ yes
Stage 1: 小模型（Haiku）提取 durable knowledge → facts/<ts>-<slug>.md
    ↓
累计 >= consolidateThreshold (10)?
    ↓ yes
Phase 2: LLM（Sonnet）合并 → memory_summary.md
```

| Setting | 默认值 |
|---------|--------|
| `memory.autoExtract` | `true` |
| `memory.extractModel` | `claude-haiku-3-5` |
| `memory.consolidateModel` | `claude-sonnet-4-6` |
| `memory.minMessagesForExtraction` | `5` |
| `memory.consolidateThreshold` | `10` |

## 与 identity 的关系

`agent-identity.ts` 之前负责读取 `memory/` 目录构建 `IdentityData.memories`。所有权已移给 `memoryPlugin`，identity 只负责 `SOUL.md` / `USER.md`。

## 关联页面

- [运行时插件机制](../runtime/plugin.md)
- [Memory 架构](../runtime/memory.md)
