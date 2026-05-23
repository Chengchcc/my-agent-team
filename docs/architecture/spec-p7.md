# Spec P-7: Tool 抽象重构 + ControlPlane 契约化 + Abort 端到端

## TL;DR

三轨并行：A 轨收掉 P-6 架构守卫最后一个豁免文件，11 处 controlplane raw emit 全部契约化；B 轨废除 ZodTool abstract class，引入 `defineTool` factory + 中央 `ToolCatalog` + `dispatch-tool` usecase；C 轨补齐 abort signal 从 TUI Esc 到 `tool.execute()` 的端到端路径。

## Why now

1. P-6 A5 白名单只剩一个文件 — `controlplane/methods.ts` 不收口，边界治理不完整
2. ZodTool abstract class 是跨 ext 引用根源 — mcp/tools/evolution 都依赖它
3. tool dispatch 不传 ToolContext — `tool.execute(call.arguments ?? {})` 单参数调用是 bug
4. abort 路径断裂 — 前端 Esc 无法取消正在执行的 tool 或 LLM stream

---

## Track A: ControlPlane 事件全量契约化

### A.1 11 处 raw emit → contractBus

| 事件 | 次数 | 之前 | 处置 |
|---|---|---|---|
| `session.created` | 1 | raw emit Session 对象 | contractBus + SessionCreatedV1 |
| `attach.changed` | 4 | raw emit | contract |
| `session.resumed` | 1 | raw emit | contract |
| `session.closed` | 1 | raw emit | contract |
| `session.renamed` | 1 | raw emit | contract |
| `user.question.answered` | 1 | raw emit | contract |
| `system.shutdown.requested` | 1 | raw emit | contract |
| `input.cancelled` | 1 | raw emit | contract |
| `turn.cancelled` | 1 | raw emit | contract |

**0 个保留 internal。**

### A.2 新建 contract: `system-events.ts`

```ts
export interface AttachChangedV1 { frontendId: string; sessionId: string; action: 'attached' | 'detached' }
export interface SessionResumedV1 { sessionId: string; frontendId?: string; previousSessionId: string | null }
export interface SessionClosedV1 { sessionId: string; force: boolean }
export interface SessionRenamedV1 { sessionId: string; title: string }
export interface UserQuestionAnsweredV1 { sessionId: string; questionId: string; answers: Array<{ question_index: number; selected_labels: string[] }> }
export interface SystemShutdownRequestedV1 { profileId: string; timestamp: string }
export interface InputCancelledV1 { sessionId: string; reason: string }
export interface TurnCancelledV1 { sessionId: string; reason: string }
```

### A.3 扩建: `session-events.ts`

`session.created` 已有 SessionCreatedV1。修正 controlplane 的 emit payload 从裸 Session 对象改为 SessionCreatedV1。

### A.4 ContractedEventMap 扩充

14 → 22 条映射（+8）。

### A.5 arch 守卫

A5 白名单删除 `controlplane/methods.ts` — 0 豁免文件。

---

## Track B: Tool 抽象重构

### B.1 类型所有权重分配

| 模块 | 内容 |
|---|---|
| `application/ports/tool.ts` | Tool interface（与 ToolImplementation 合并后的唯一类型） |
| `application/ports/tool-context.ts` | ToolContext（P-6 收缩版，不变） |
| `application/ports/tool-executor.ts` | ToolExecutor port |
| `application/ports/tool-catalog.ts` | ToolCatalog port（可写） |
| `application/tool-factory/define-tool.ts` | defineTool() factory |
| `application/tool-catalog/in-memory-catalog.ts` | ToolCatalog 默认实现 |
| `application/usecases/dispatch-tool.ts` | 编排逻辑 |
| `infrastructure/tool/in-process-executor.ts` | ToolExecutor 默认实现 |
| `extensions/tool-catalog/index.ts` | 独立 extension（enforce: pre） |
| `extensions/tools/internal/parse-with-zod.ts` | zod → parse 5 行 helper |

### B.2 统一 Tool interface

```ts
// application/ports/tool.ts
export interface Tool {
  name: string
  description: string
  parameters: Record<string, unknown>
  parse?: (raw: Record<string, unknown>) => Record<string, unknown>
  execute: (ctx: ToolContext, params: Record<string, unknown>) => Promise<unknown>
  readonly?: boolean
  conflictKey?: (input: unknown) => string | null
}
```

`ToolImplementation` 删除，与 `Tool` 合并。`ToolContext` 保持 `{ signal: AbortSignal, environment: { cwd: string } }`。

### B.3 defineTool factory

```ts
// application/tool-factory/define-tool.ts
export function defineTool(config: {
  name: string
  description: string
  parameters: Record<string, unknown>
  parse?: (raw: Record<string, unknown>) => Record<string, unknown>
  execute: (ctx: ToolContext, params: Record<string, unknown>) => Promise<unknown>
  readonly?: boolean
  conflictKey?: (input: unknown) => string | null
}): Tool
```

### B.4 ToolCatalog（独立 extension）

```ts
// application/ports/tool-catalog.ts
export interface ToolCatalog {
  register(tool: Tool): void
  unregister(name: string): void
  list(): Tool[]
  get(name: string): Tool | undefined
}
```

Extension `tool-catalog`（enforce: pre），~20 行：`new InMemoryCatalog()` + `provide: { catalog: () => catalog }`。

### B.5 dispatch-tool usecase

```ts
// application/usecases/dispatch-tool.ts
export async function dispatchTool(
  catalog: ToolCatalog,
  executor: ToolExecutor,
  call: { name: string; arguments: Record<string, unknown> },
  ctx: ToolContext,
): Promise<unknown>
```

逻辑：`catalog.get(call.name)` → `tool.parse(call.arguments)` → `executor.execute(tool, input, ctx)`。

### B.6 ToolExecutor port

```ts
// application/ports/tool-executor.ts
export interface ToolExecutor {
  execute(tool: Tool, input: Record<string, unknown>, ctx: ToolContext): Promise<unknown>
}
```

默认实现 `InProcessExecutor`：`return tool.execute(ctx, input)`。未来可换沙箱执行器。

### B.7 tools ext 降格为 builtin provider

- 依赖 `tool-catalog` extension
- `apply()` 中：9 个 `defineTool({...})` + `catalog.register(tool)`
- 删除所有内联 `registerTool()` + inline `execute` 函数体
- 删除 `src/extensions/tools/tools/zod-tool.ts`（234 行）
- `tools/index.ts` 300 → ~60 行
- `onToolCall` hook 保留：调 `dispatchTool` usecase

### B.8 zod 退守

```
extensions/tools/internal/parse-with-zod.ts  ← 唯一 zod 导入点
  export parseWithZod(schema) → parse function
```

9 个 builtin tool 在 ext internal 定义 zod schema → 调用 `parseWithZod` → 传给 `defineTool` 的 `parse` 字段。

其他 ext（mcp/skills/evolution）不 import zod。mcp tool 的 input schema 走 JSON Schema → 传给 `defineTool` 的 `parameters` 字段。

### B.9 删除项

- `src/extensions/tools/tools/zod-tool.ts`（234 行）
- `src/types.ts` 中 `Tool`/`ToolImplementation` 的 shim re-export
- `src/application/ports/tool-context.ts` 中 `Tool`/`ToolImplementation` 定义
- 9 个 class tool 的 import 路径从 `../../../types` 改为 `../../../application/ports/tool`

---

## Track C: Abort 端到端

### C.1 完整路径

```
TUI Esc
  → ControlPlane 'input.cancel' RPC
  → session extension: abortController.abort()
  → signal 分发三路:
     ├─ provider.stream({ signal }) → LLM fetch 中断
     ├─ dispatch-tool → tool.execute(ctx, params) → ctx.signal.aborted → 善后
     └─ turn-runner loop → 下轮迭代前 break
```

### C.2 session extension 加 abort 能力

```ts
// extensions/session/index.ts
private abortControllers = new Map<string, AbortController>()

provide: {
  abort: () => ({
    register: (sessionId: string, controller: AbortController) => {
      this.abortControllers.set(sessionId, controller)
    },
    unregister: (sessionId: string) => {
      this.abortControllers.delete(sessionId)
    },
    abort: (sessionId: string) => {
      this.abortControllers.get(sessionId)?.abort()
    },
  }),
}
```

### C.3 controlplane input.cancel 触发 abort

```ts
// controlplane/methods.ts 'input.cancel'
const sessionAbort = ctx.extensions.get('session.abort')
sessionAbort.abort(sessionId)
contractBus.emit(createEvent('input.cancelled', { sessionId, reason }))
```

### C.4 run-turn.ts 创建 controller

```ts
// run-turn.ts
const controller = new AbortController()
sessionAbort.register(sessionId, controller)
try { /* turn execution */ }
finally { sessionAbort.unregister(sessionId) }
```

signal 传三处：
- `provider.stream({ signal: controller.signal })`
- `tool.execute(ctx, params)` 的 ctx 含 signal
- turn-runner 每轮 `if (controller.signal.aborted) break`

---

## 不变量

| 不变量 | 内容 |
|---|---|
| **INV-Tool-Catalog-1** | ToolCatalog 是唯一 tool 注册入口；任何 ext 不得拥有自己的 LLM-visible tool registry |
| **INV-Tool-Catalog-2** | ext 间唯一 cross-ext 媒介是 ToolCatalog port |
| **INV-Tool-Schema-1** | zod 仅限 `application/contracts/**` + `extensions/tools/internal/**` |
| **INV-Tool-Schema-2** | tool input schema 不提升至 contracts |
| **INV-Abort-1** | 每个运行中的 turn 有唯一 AbortController，session-level 管理 |
| **INV-Abort-2** | tool.execute 的 ctx.signal 和 provider.stream 的 signal 来自同一 AbortController |

---

## Commit Plan

| # | Track | Commit |
|---|---|---|
| 1 | A | `feat(p7): add system-events contract + extend session-events` |
| 2 | A | `refactor(p7): migrate controlplane methods to contractBus` |
| 3 | A | `chore(p7): remove controlplane from A5 whitelist` |
| 4 | B | `refactor(p7): introduce Tool interface in ports/tool.ts, merge ToolImplementation` |
| 5 | B | `feat(p7): defineTool factory + dispatch-tool usecase + ToolExecutor port` |
| 6 | B | `feat(p7): ToolCatalog port + in-memory catalog + extension` |
| 7 | B | `refactor(p7): migrate 9 builtin tools to defineTool, delete ZodTool` |
| 8 | B | `refactor(p7): wire tool-catalog into tools/mcp extensions` |
| 9 | B | `chore(p7): shrink tools/index.ts, update import paths, delete dead files` |
| 10 | C | `feat(p7): add AbortController management to session extension` |
| 11 | C | `feat(p7): wire abort signal through run-turn → turn-runner → dispatch-tool → provider` |
| 12 | C | `feat(p7): wire input.cancel RPC to trigger session abort` |

---

## 修改/新增/删除文件

### 新增

- `src/application/contracts/system-events.ts`
- `src/application/ports/tool.ts`
- `src/application/ports/tool-executor.ts`
- `src/application/tool-factory/define-tool.ts`
- `src/application/tool-catalog/in-memory-catalog.ts`
- `src/application/usecases/dispatch-tool.ts`
- `src/infrastructure/tool/in-process-executor.ts`
- `src/extensions/tool-catalog/index.ts`
- `src/extensions/tools/internal/parse-with-zod.ts`

### 修改（部分）

- `src/application/contracts/session-events.ts` — 扩建
- `src/application/contracts/events/contracted-event-map.ts` — +8 映射
- `src/extensions/controlplane/methods.ts` — 11 emit → contractBus + abort 接线
- `scripts/check-architecture.ts` — A5 白名单清空
- `src/application/ports/tool-catalog.ts` — stub → 真实接口
- `src/application/usecases/run-turn.ts` — +AbortController wiring
- `src/domain/turn-runner.ts` — +signal 检查
- `src/extensions/session/index.ts` — +abortControllers
- `src/extensions/tools/index.ts` — 300→~60 行
- `src/extensions/mcp/index.ts` — 改道走 catalog
- `src/types.ts` — 删 Tool/ToolImplementation shim

### 删除

- `src/extensions/tools/tools/zod-tool.ts`
- `src/application/ports/tool-context.ts` 中 Tool/ToolImplementation 定义

---

## 验证

1. `bun test` 全绿
2. `grep "ctx.bus.emit(" src/extensions/controlplane/methods.ts` → 0 results
3. `grep "registerTool" src/extensions/tools/index.ts` → 0 results
4. `grep "ZodTool" src/` → 0 results
5. `grep "ToolImplementation" src/` → 0 results
6. A5 arch guard：故意在 controlplane 写 `ctx.bus.emit('session.created', ...)` → 报 `[A5]`
7. abort 集成测试：前端 Esc → tool 收到 `ctx.signal.aborted === true`
