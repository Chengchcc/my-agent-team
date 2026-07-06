# Retro: 塌缩 harness 调用层

> SessionManager + ctx.span + HookContext\<Ctx\> — 2026-07-03 ~ 2026-07-06

## 一、实际交付 vs 计划

| 计划 (spec v4→v5) | 实际 | 偏离原因 |
|---|---|---|
| 5 步 TDD 执行 | 10 Phase → 两轮深化迭代完成 | spec 未预见 `buildAgentConfig` 删除、`HookContext<Ctx>` 泛型、命名泄漏修正等深化工作 |
| `tracePlugin` 包装 `startMainRun/notifyRunComplete` | 废弃——改为 `ctx.span` + `startSpan` 注入，framework 自动管理 | OTel 式 context propagation 更干净，tracePlugin 变成多余中间层 |
| `conversation_session` 独立表 | 废弃——改为 `member.session_id` 字段 | 绑定是领域概念，归各 feature 自己的表，不做中央映射表 |
| `executeAgentRun` 逻辑"散到各 feature" | 废弃——追踪逻辑下压到 `supervisor.startSpan`，feature 不碰 | 用户坚持"技术下压、业务上浮"，散到 feature 是伪分解 |
| `buildAgentConfig` 删 conversation 参数 | **整个函数删除**，换 `agent-helpers.ts` 纯函数 | `agent` 和 `agentId` 冗余被发现，函数退化成黑盒参数袋 |
| `subscribe(AgentEvent)` 不变 | 讨论过 `onMessage/onTodoUpdate/onEnd` 包装，最终保留 `subscribe` | 用户判断 `subscribe` 已是单一入口，额外包装是重复 |
| 删除清单 11 项 | **全部删除 + 额外删除 `agent-config.ts`** | 深化过程发现 `buildAgentConfig` 整个不该存在 |
| 测试 340 pass | **340 pass / 0 fail** | 无偏离 |

## 二、设计演化——spec 到实现的三次转向

### 转向 1: tracePlugin → ctx.span

spec 原定 `tracePlugin` 作为 wrapper 接管 `startMainRun/notifyRunComplete`。审查发现 plugin hooks 不支持 `afterRun`，且 tracePlugin 需要业务数据（issueId/cronJobId）——违反"技术下压"原则。

**转向**：借鉴 OTel 的 Context+Span 模式。framework 定义 `RunSpan` 接口，`startSpan` 通过 `AgentSessionConfig` 注入，`run()` 的 finally 自动 `span.end()`。feature 层零介入。

### 转向 2: `ctx.conversation: unknown` → `HookContext<Ctx>.data`

spec 原定 `HookContext` 加 `conversation?: unknown`，plugin 做 `as ConversationContext`。审查发现三个问题：(1) 字段名 `conversation` 泄漏业务概念到 framework；(2) 只有一个消费者却用 `unknown`，丢失类型安全；(3) 未来多 plugin 各自需要不同类型时会膨胀。

**转向**：经历三次设计迭代——`unknown` → 泛型 `HookContext<Ctx>` → symbol-key → 回到泛型 `HookContext<Ctx>` + `data?: Ctx`。最终选择泛型：`Ctx` 默认 `Record<string, unknown>`，conversation 传 `ConversationShape`，plugin 侧 `ctx.data` 自动收窄到具体类型。

### 转向 3: `buildAgentConfig` 参数简化 → 整个删除

spec 原定删 `surface/senderName/input` 三个 conversation 参数，保留 `agent/agentId/config/convPort/conversationId`。审查发现 `agent` 和 `agentId` 冗余（agentId 只用于算 cwd），`agent.modelProvider` 零引用，`agent.modelBaseUrl` 被 config 覆盖。

**转向**：整个 `agent-config.ts` 删除。换成 6 个纯函数：`createModel`、`defaultTools`、`convTools`、`defaultPlugins`、`conversationPlugins`（后来也删了）、`defaultContextManager`。feature 内联组装。

## 三、实现中发现的 Bug

### B1: `validatePlugins` configTools 循环丢失

**根因**：`plugin.ts` 的 `validatePlugins` 加泛型 `<Ctx>` 时，sed 误删了 `for (const t of configTools) seen.set(...)` 循环。导致 config 和 plugin 间的工具重名无法检测。

**修复**：手动补回循环。`plugin.test.ts` 的 2 个碰撞检测测试恢复通过。

**教训**：批量文本替换（eval/sed）在函数体重构时极易破坏控制流。泛型化应该用 `write` 重写整个文件，而非 `edit` 修补。

### B2: `fireBeforeTool` try-catch 丢失

**根因**：`plugin-runner.ts` → `plugin-dispatcher.ts` 重写时，`fireBeforeTool` 从 `eachPlugin`（有 try-catch）改成直接 `for` 循环（无 try-catch）。plugin 抛出的 `InterruptSignal` 传播到了 agent 层。

**修复**：`for` 循环内补 `try { ... } catch { logger.warn(...) }`。

**教训**：提取/重写调度函数时，每个 hook fire 的错误隔离语义必须保留。`eachPlugin` 的 try-catch 不是"样板"，是合约。

### B3: agent-session.ts 重写丢失 retry/compaction

**根因**：为加速泛型化，直接用 `write` 完整重写了 ~460 行的 `agent-session.ts`，但简化了 `#executeSpan` 的 retry 循环和 `#handleAgentEvent` 的 compaction 触发逻辑。6 个 harness 测试失败。

**修复**：`git checkout` 恢复原文件，改为最小精确编辑——只加 `SessionConfig` 接口、`AgentSession<Ctx>` 泛型、`setData()`、`#data` buffer、`sessionId` getter、`startSpan` 注入、`data` 传递。不碰现有状态机。

**教训**：写完整文件替代大文件是高风险操作——哪怕"理解"了代码，也会丢失细节。加新功能用最小 patch，重构已有逻辑才考虑 rewrite。

## 四、设计决策记录

### D1: `SessionConfig` 拆分——caller 看不到注入字段

`AgentSessionConfig` 原有 12 个字段，其中 5 个是 caller 提供的（model/tools/plugins/contextManager/systemPrompt），3 个是 SessionManager 注入的（sessionId/checkpointer/startSpan），4 个是内部默认的（retry/compaction/maxSteps/logger）。caller 通过 `Omit<AgentSessionConfig, "sessionId" | "checkpointer">` 避免传注入字段——但 `startSpan` 未被 Omit，类型上有漏洞。

**决策**：拆为 `SessionConfig`（5 字段，export）和 `AgentSessionConfig extends SessionConfig`（全字段，不 export）。caller 只看到 `SessionConfig`，SessionManager 内部补注入字段。

### D2: `conversationPlugins` 5 参数——被识别为 buildAgentConfig 重演

`conversationPlugins(cwd, workspaceRoot, convPort, conversationId, skillRoots?)` 有 5 个参数，且 `workspaceRoot` 在所有调用点都从 `config.workspaceRoot` 取。

**决策**：删除 `conversationPlugins`。conversation-compose 内联 `[...defaultPlugins(cwd, config), conversationContextPlugin({...})]`。同时 `defaultPlugins` 改为传 `config` 而非 `workspaceRoot`（3 调用点都取 `config.workspaceRoot`）。

### D3: `Plugin<ConversationContext>` 泛型撤回

`conversationContextPlugin` 原返回 `Plugin<ConversationContext>`，但在 `SessionConfig.plugins`（类型 `Plugin[]` = `Plugin<Record<string, unknown>>[]`）处不兼容，需要 `as unknown as Plugin` 补丁。

**决策**：撤回 `Plugin` 泛型。`conversationContextPlugin` 返回 `Plugin`（默认泛型）。plugin 内部 `beforeModel` 收到 `ctx.data` 为 `Record<string, unknown>`，自己收窄：`as unknown as ConversationContext`。泛型只在 HookContext 层面生效（`ctx.data` 的读写），不传播到 Plugin 容器。

### D4: `convTools` 重复计算——提取为局部变量

conversation-compose 的 `create/open` config 中，`convTools(convPort, conversationId)` 被调了两次（tool 数组和 plugin 的 conversationContextPlugin 参数各一次）。

**决策**：提取 `const cTools = convTools(convPort, conversationId)`，复用。同时 `create` 和 `open` 的 config 块完全重复，提取为 `const agentConfig = {...}`。

### D5: `plugin-runner.ts` 命名 → `plugin-dispatcher.ts`

原名 `plugin-runner` 暗示它是一个叫 "runner" 的 plugin（packages 下有 `plugin-task-guard`、`plugin-identity` 等真 plugin）。实际它是 plugin 的调度函数——按注册顺序 fire hooks。

**决策**：重命名为 `plugin-dispatcher.ts`。3 个引用文件同步更新。

## 五、做得好的

1. **分层审查逐轮加深**：第一轮完成 spec 核心目标（SessionManager + ctx.span），第二轮到第三轮逐层审查函数签名、参数泄漏、命名泄漏——每轮发现问题后立即修正，不让技术债堆积
2. **"技术下压、业务上浮"原则贯穿始终**：每次设计决策都以这个原则为准绳。`insertSpanOrigin` 下压到 supervisor、`origin` 上浮到 prompt opts、`conversation` 上下文上浮到 `setData` + `ctx.data`
3. **spec/ADR 同步更新**：ADR 0009 从 Proposed → Accepted，spec v4 → v5，每次设计转向后都更新文档
4. **0 typecheck error + 340 pass / 0 fail**：43 个文件的改动没有引入回归
5. **多余文件的及时清理**：`agent-config.ts`、`context.ts`、`context-key.ts` 在发现设计转向后立即删除，没有"先留着以后再说"

## 六、如果重来一次

1. **泛型化不用 eval/sed**：B1（configTools 循环丢失）和 B3（agent-session 重写丢失 retry）的根因都是 batch 替换。应该读完整文件 → 理解 → `write` 一次性替换。
2. **`Plugin<Ctx>` 泛型不应传播到 Plugin 容器**：D3 的撤回表明 `Plugin` 泛型是过度设计——泛型只需要在 `HookContext.data` 的读写点生效，不应传播到插件容器类型上。这个回退消耗了 ~2 小时。
3. **大文件重写前先备份全量测试**：B3 时 `agent-session.ts` 重写后 6 个测试失败，但发现时已经做了 10+ 个 edit。应该先跑 `bun test --coverage` 确认改动前的基线，再重写。
4. **`conversationPlugins` 应该在 spec 审查阶段就识别出来**：5 参数函数是明显的 code smell——如果 spec 阶段做一次"参数计数审查"，可以提前删除。
5. **commit 频率过高**：整个重构超过 100 个 edits，但没有一次 commit——所有改动在 working tree 里。如果中途有 git commit checkpoint，B3 的回滚可以用 `git stash` 而非手动修复。

## Retro 结束。

关联 spec: [塌缩 harness 调用层 v5](../specs/2026-07-03-collapse-harness-invocation.md) · ADR: [0009](../../adr/0009-session-layer-owns-identity-features-own-binding.md)
