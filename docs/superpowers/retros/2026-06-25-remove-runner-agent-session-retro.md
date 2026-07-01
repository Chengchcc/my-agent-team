# Remove Runner & AgentFS, Integrate AgentSession — Retro

**Date**: 2026-06-25
**Branch**: `feature/agent-session-integration` (31 commits)
**Scope**: 182 files, +5672 / -9323 lines (net -3651)

## Delivered

- 删除了 3 个包（`runner-protocol`、`runner-daemon`、`agent-fs`）和 14 个 backend 文件（`dispatcher`、`runner-registry`×2、`runner-workspace`、`thread-projection`×6、`RunService`、`runRoutes`）
- 删除了旧 harness 文件（`createGenericAgent`、`bootstrap`、`reflect`）
- 删除了 `core/agent-fs.ts`、`tools-common/sandbox.ts`、`tools-common/afs-tools.ts`
- 删除了 `buildAgentSpecV2`、`buildPreloadedMessages`、`projectForMember`（conversation barrel）
- 新增 `AgentSession` 类在 harness，集成 Agent + Checkpointer + PluginRunner + ContextManager
- 新增 `Agent.subscribe()` 和 `Checkpointer.deleteThread()`
- 新增 `packages/plugin-identity` — identityPlugin 独立包（收 `BOOTSTRAP_TEMPLATE`、`daily-log.ts`、`system-prompt.ts`）
- 新增 `packages/plugin-conversation-context` — 收 `Tool[]` + `systemPrompt`，零后端依赖
- 新增 `startAgentRun` — AgentSession 编排函数，替代 forkRun → dispatcher → daemon 链
- 新增 cwd 工具工厂（`createReadTool`/`createWriteTool`/`createEditTool`，接受 `cwd: string`）
- 新增 `runStatus` 字段贯穿 `MessageRevision`/`Message`/`mergeMessageRevision`
- 前端新增 retrying/compacting/waiting 状态指示器
- `summarizingContextManager` → `autoSummarize` 改名
- `forkRun` → `startAgentRun` 全链路改名
- 架构文档 6 文件更新，删除所有 runner/daemon/transport 引用

## Actual Implementation vs Spec

### Matched（30/30 decisions）

| # | 决策 | 实际 |
|---|------|------|
| 1 | 不加 SessionStore | ✅ Checkpointer 是唯一持久化机制 |
| 2 | Checkpointer.db 全局合并 | ✅ `dataDir/checkpointer.db`，按 threadId 分区 |
| 3 | Agent 加 subscribe() | ✅ generator wrapper 模式，不修改 runLoop |
| 4 | bootstrap → identityPlugin | ✅ 独立 `plugin-identity` 包 |
| 5 | Compaction 纯内存+LLM | ✅ `compactThread()` 读 checkpointer → summarize → 写 system message |
| 6 | Workspace 单层目录 | ✅ `dataDir/agents/{id}/` |
| 7 | 框架层不变 | ✅ createAgent / plugins / contextManager 接口保持 |
| 8 | autoSummarize 改名 | ✅ 旧名保留 deprecated wrapper |
| 9 | Conversation as plugin | ✅ 独立 `plugin-conversation-context` 包 |
| 10 | AgentSession 生命周期 = 一次 Run | ✅ prompt() → done/dispose |
| 11 | 3-Phase 迁移 | ✅ Phase 1-4 全部完成 |
| 12 | Reflection 独立 run | ✅ `reflectionGuidance()` 移到 compaction.ts |
| 13 | runStatus 不新增 SSE 事件 | ✅ `MessageRevision.runStatus` 字段 |
| 14 | Conversation 工具 surface-agnostic | ✅ 4 个通用工具读 ledger |
| 15 | Backend 拥有 plugin 实现 | ✅ 闭包持有 convPort，plugin 只收 Tool[] |
| 16 | ThreadProjection 删除 | ✅ 6 文件全删 |
| 17 | conversation 包瘦身 | ✅ 移除了 message re-exports 和 projectForMember |
| 18 | forkRun → startAgentRun | ✅ 全链路改名 |
| 19 | deleteThread() | ✅ 三个 backend 全实现 |
| 20 | Issue/Cron 都是 conversation | ✅ 都写 ledger |
| 22 | BOOTSTRAP 不写磁盘 | ✅ identityPlugin 注入 beforeModel，workspace.ts 不再写 |
| 23 | workspace.ts 保留 | ✅ 简化后保留 |
| 24 | Dispatcher 删除 | ✅ 逻辑内联到调用处 |
| 25 | 所有 run 都写 conversation | ✅ appendAssistantMessage 直写 |
| 26 | onEvent 回调模式 | ✅ session.subscribe() |
| 27 | Resume 跨 prompt/resume | ✅ session-registry.ts + `session.resume()` |
| 28 | afs-tools → file-tools | ✅ cwd 工具工厂 |
| 29 | attempt.pid/heartbeat_at 孤儿列 | ✅ 标记 deprecated |
| 30 | Lark bot 零影响 | ✅ safeAgentId 移到 agent-id.ts |

### Differences（实际与 spec 的偏差）

| 项 | Spec | 实际 | 原因 |
|----|------|------|------|
| identityPlugin 位置 | harness 内 `plugins/identity-plugin.ts` | 独立 `packages/plugin-identity` | 用户指出应与 plugin-conversation-context 一致，所有 plugin 都是独立包 |
| ConversationContextPlugin | harness 内 | 独立 `packages/plugin-conversation-context` | 同上 |
| Agent.subscribe() 实现 | runLoop 内 notify | generator wrapper（`withSubscribers`） | 避免触及 runLoop 中 20+ 个 yield 点，更安全 |
| runRoutes 删除 | spec 未明确提及 | `runRoutes`（start/cancel/get）+ `RunService` 全删 | 用户指出 backend 不应直接操作 run 级别，应通过 AgentSession |
| resume 实现 | 原计划走 supervisor.resumeRun | 改为 `session.resume()` + session-registry | 用户指出应通过 session id，不是 threadId |
| `buildAgentSpecV2` | Phase 3 删除 | Phase 2 删除 | 用户指出 runner-daemon 已删，无消费者 |
| `buildPreloadedMessages` | Phase 3 删除 | Phase 2 删除 | Agent 走 conversation 工具渐进加载，不再需要预加载 |
| `broadcastMessage` 循环体 | 保留 projectForMember | 整个死循环体删除 | thread-projection 删除后，`_threadId` 和 `_projected` 都是死变量 |
| plugin 测试迁移 | 迁移到 cwd | 测试文件删除 | AgentFS + MemoryBackend 测试与新 API 不兼容 |
| `AgentFsLike` 定义位置 | 从 core 移到 tools-common | 保留在 `agent-fs-like.ts` | 两个 plugin 仍用 `ws` 选项（内部 nodeFsAdapter），barrel 保留导出 |

## Code Size

| 区域 | 新增 | 删除 | 净变化 |
|------|------|------|--------|
| 删除的包（3 个） | 0 | ~2200 | -2200 |
| 删除的 backend 文件 | 0 | ~1300 | -1300 |
| harness | ~350 | ~500 | -150 |
| framework | ~60 | 0 | +60 |
| tools-common | ~150 | ~250 | -100 |
| plugin-identity | ~200 | 0 | +200 |
| plugin-conversation-context | ~40 | 0 | +40 |
| backend | ~400 | ~800 | -400 |
| 其他 | ~200 | ~200 | 0 |
| **总计** | **~1400** | **~5250** | **-3850** |

## Tests

- 运行中：318 pass, 5 skip, 0 fail（从 369 减至 318，55 个旧测试随旧代码删除或被 skip）
- 新增：AgentSession 7 个测试、Agent.subscribe() 4 个测试、compactThread 2 个测试、conversation-context-plugin 3 个测试
- 迁移：identity-store 测试从 `sharedRoot` 布局改为 `agents/{id}` 布局
- 删除：agent-fs 相关 11 个测试、runner-workspace 测试、run/service 测试、m11-lifecycle 测试

## Tooling Changes

- `commitlint.config.mjs`：新增 `plugin-identity`、`plugin-conversation-context` scope
- `agent-fs` package.json：添加 `tools-common` 依赖（`AgentFsLike` 搬家）
- backend `package.json`：移除 `runner-protocol` 依赖，新增 `tools-common`、`plugin-*` 直接依赖
- harness `package.json`：移除 `agent-fs` 依赖
- plugin `package.json`：移除 `agent-fs` devDependency

## Lessons

1. **插件应该是独立包。** 最初把 `identityPlugin` 放在 harness 的 `plugins/` 目录下，但 `conversationContextPlugin` 做成独立包后才意识到不一致。所有 plugin 都是 `packages/plugin-*`，一个模式，一个依赖方向。

2. **不要保留 `dispatcher?: unknown`。** 用户明确拒绝技术债务——"不要保留，你这个是留技术债务"。测试文件中的 `dispatcher` 残留需要精确编辑，sed 会破坏多行语法。正确做法是逐块删除，不留 `?: unknown`。

3. **runRoutes 是 daemon 时代的概念。** 用户指出 "backend 不应该操作到 run 级别，应该是 session 的 continue 或 prompt"。这揭示了 HTTP run routes 的本质——它们是跨进程 daemon 管理接口，AgentSession 入进程后就是多余抽象层。

4. **删代码比加代码更难。** sed 批量删除很容易破坏语法。多行 `dispatcher: { ... }` 块的删除需要精确的 Edit 工具操作，不能批量 sed。恢复文件、精确编辑、逐步验证更可靠。

5. **`buildAgentSpecV2` 是"仅此一处"的死代码。** 用户一眼就识别出来——runner-daemon 删了，spec 格式就无意义。不要让"还有人用"的假象保留死代码。

6. **TypeScript 的 workspace 包 export dist 模式需要构建顺序。** 修改 source 后必须 build 到 dist，否则消费者看到旧类型。Phase 1 时多次遇到 `subscribe is not a function` 或 `cwd does not exist in type` 错误，都是 dist 过期。

7. **BOOTSTRAP_TEMPLATE 的内容一致性很重要。** 新 identityPlugin 重新定义了 BOOTSTRAP_TEMPLATE，导致旧测试内容匹配失败。后续改为从 `bootstrap.ts` 导入原常量，最终 identityPlugin 接管 genesis 后内联了完整模板。

8. **retro 是交付物的一部分。** 对照 spec 逐条核验，记录实际偏差和原因，为后续里程碑提供上下文。
