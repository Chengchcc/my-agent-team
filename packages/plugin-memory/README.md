# @my-agent-team/plugin-memory

给 agent 一份文件系统支撑的长期记忆。提供 read / retain / search 三套工具 + 自动提取 pipeline。

## 核心概念

记忆存在 per-agent 工作区的 `memory/` 目录：

```
memory/
├── memory_summary.md   ← Phase 2 输出，注入 system prompt
└── facts/
    ├── <ISO-TS>-<slug>.md
    └── ...
```

每轮模型调用前，插件读 `memory_summary.md` 注入 `<memory>` 标签（mtime 缓存）。可选开启 `autoExtract`，每轮后自动用 LLM 提取记忆 + 合并。

## 工具

- **memory_read** — 读记忆内容（不传 path → 读 memory_summary.md）
- **memory_retain** — 批量写入 `{ items: [{ content, context?, tags? }] }`
- **memory_search** — 多词 AND 搜索 + 时间过滤（`since: "7d"`）

## 用法

```ts
import { memoryPlugin } from "@my-agent-team/plugin-memory";

const plugin = memoryPlugin({
  cwd: "/path/to/agent/workspace",
  root: "./memory/",
  enableWrite: true,
  limit: 5,
  // 自动提取
  autoExtract: true,
  extractModel: haikuModel,
  consolidateModel: sonnetModel,
  minMessagesForExtraction: 5,
  consolidateThreshold: 10,
});
```
