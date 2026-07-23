# Memory

Memory 是 agent 跨 session 保持上下文的核心机制。`plugin-memory` 提供三套工具（read / retain / search）+ 自动提取 pipeline，写入 agent workspace 的文件系统。

## 关键实现文件

- `packages/plugin-memory/src/memory-plugin.ts` — 插件入口：Tool 注册 + beforeRun 注入 + afterModel 自动提取
- `packages/plugin-memory/src/auto-memory.ts` — 两阶段 LLM pipeline（提取 + 合并）
- `packages/plugin-memory/src/prompts.ts` — Stage 1 提取 prompt + Phase 2 合并 prompt（抄 OMP）
- `packages/plugin-memory/src/memory-retain.ts` — 批量记忆写入工具
- `packages/plugin-memory/src/memory-search.ts` — 多词 AND 搜索 + 时间过滤
- `packages/plugin-memory/src/memory-read.ts` — 记忆读取工具
- `packages/plugin-memory/src/cache.ts` — mtime-based 内存缓存（避免频繁 I/O）
- `packages/plugin-memory/src/frontmatter.ts` — YAML frontmatter 格式读写（ts/title/tags/context）

## 数据模型

### 存储结构（per-agent）

```text
dataDir/agents/<agentId>/memory/
├── memory_summary.md   ← Phase 2 输出：1-3 句浓缩上下文，注入 system prompt
└── facts/
    ├── 2026-07-22T12-00-00-jwt-auth-fix.md
    └── 2026-07-22T12-05-00-redis-timeout-5s.md
```

### Facts 文件格式（YAML frontmatter）

```yaml
---
ts: 2026-07-22T12-00-00
title: "JWT auth fix"
tags: ["auth", "middleware"]
context: "auth-service.ts login flow"
---
具体内容...
```

## 工具

### memory_retain

```typescript
// 批量写入（替代旧的 memory_write）
memory_retain({
  items: [
    { content: "Redis timeout is 5s", context: "auth-service.ts login flow", tags: ["infra"] },
    { content: "JWT expiry set to 15m", tags: ["auth"] },
  ]
})
```

### memory_search

```typescript
// 多词 AND 搜索 + 时间过滤
memory_search({ query: "JWT login", since: "7d", limit: 5 })
```

算法：分词 → AND 匹配 → 命中密度打分 → 时间过滤 → top N

### memory_read

```typescript
memory_read({ path: "memory/facts/2026-07-22-jwt.md" })
// 不传 path → 读 memory_summary.md
```

## 自动记忆 pipeline

### 触发

`memoryPlugin.afterModel` 每轮模型调用后执行：

```
autoExtract && extractModel 存在?
    ↓ yes
lastExtractedCount 以来的新消息 >= minMessagesForExtraction (默认 5)?
    ↓ yes
Stage 1: 小模型提取 durable knowledge
    ↓
写入 memory/facts/<ts>-<slug>.md
    ↓
新增 facts >= consolidateThreshold (默认 10)?
    ↓ yes
Phase 2: LLM 合并 → memory_summary.md
```

### Stage 1：提取

输入：本轮增量消息 + `STAGE_ONE_PROMPT`（抄 OMP）  
输出：JSON `{ items: [{ content, context, tags }], rollout_summary }`  
模型：`memory.extractModel`，默认 `claude-haiku-3-5`

### Phase 2：合并

输入：所有 facts 文件 + `CONSOLIDATION_PROMPT`  
输出：JSON `{ memory_summary: "1-3 sentences" }`  
模型：`memory.consolidateModel`，默认 `claude-sonnet-4-6`

## 注入

`memoryPlugin.beforeRun` → 读 `memory_summary.md`（mtime 缓存）→ `MemoryKey` context → `conversation-compose metaContext` → `<memory>` XML 标签 → system-reminder

## Settings 配置

| Key | 默认值 |
|-----|--------|
| `memory.autoExtract` | `true` |
| `memory.extractProvider` | `anthropic` |
| `memory.extractModel` | `claude-haiku-3-5` |
| `memory.consolidateProvider` | `anthropic` |
| `memory.consolidateModel` | `claude-sonnet-4-6` |
| `memory.minMessagesForExtraction` | `5` |
| `memory.consolidateThreshold` | `10` |

## 与 identity 的关系

`agent-identity.ts` 之前负责读取 `memory/` 目录构建 `IdentityData.memories`。所有权已移给 `plugin-memory`，identity 只负责 `SOUL.md` / `USER.md`。
