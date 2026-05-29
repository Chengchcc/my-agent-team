# Sub-Agent M3 — Frontend Observability + Controlplane RPC + Contract Hardening

> **Status**: Final (grilled 2026-05-30)
> **Predecessor**: M2 process isolation (commits `d790a56` → `caa2f40`) + Q1-Q8 follow-up fixes
> **Scope**: 完成 sub-agent 子系统的最后一公里 —— 修 M2 残留 bug、补可视化(widget + TUI)、上行进度事件、暴露 controlplane RPC、关键安全 invariants 落地。本 milestone 之后 sub-agent 子系统功能完整，无后续 milestone。

---

## 0. 范围一图

```
┌─ M2 残留修复(R-1 ~ R-3)─────────────────────────────────┐
│  contract V1 缺字段 / bus.emit 配对约束失效 / sessionId 越界 │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─ M3 安全 invariants(S-1 ~ S-4)──────────────────────────┐
│  ask_user_question 硬规则 / sub 嵌套硬规则 / modelHint 闭包注入 │
│  空 round 计数器                                            │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─ M3 进度链路(P-1 ~ P-5)─────────────────────────────────┐
│  progress IPC frame / parent emit subagent.progress /        │
│  dataplane 桥扩                                              │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─ M3 可视化(W-1 ~ W-5)─────────────────────────────────┐
│  widget payload / widget-bridge stateful subscriber /        │
│  TUI projector(折叠/展开) + GC sweep (5min interval)         │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─ M3 Controlplane RPC(C-1 ~ C-2) ─ + C-3 独立 PR-5 ──────┐
│  subagent.list / subagent.describe / subagent.invoke(调试) │
└─────────────────────────────────────────────────────────────┘
```

---

## 1. M2 残留 Bug Fixes

### R-1 — Contract V1 字段补全 + 错误三层架构

#### R-1.0 错误分类三层

错误体系分为三个独立层次，各司其职：

| 层 | 类型 | 关注点 | 实例 |
|---|---|---|---|
| **L1 传输层** | `LlmFailureReason`(7 种) | LLM 调用本身的失败模式 | `network` / `rate_limit` / `auth` / `invalid_response` / `unknown` + WorkerRpcError 映射 |
| **L2 执行层** | mini-loop `finishReason`(字符串) | sub-agent 这次 run 怎么结束的 | `stop` / `length` / `content_filter` / `tool_calls` / `budget` / `tool_failed` / `tool_unavailable` / `max_rounds` / `inconsistent` / `empty` / `error` |
| **L3 业务层(contract)** | `SubAgentErrorType`(12 种枚举) | 给前端 / dataplane 看的语义分类 | `cancelled` / `failed` / `busy` / `unknown_type` / `max_rounds` / `budget` / `tool_failed` / `tool_unavailable` / `llm_failed` / `response_truncated` / `response_filtered` / `provider_inconsistent` / `empty_response` |

**L2 → L3 映射**(runner-spawner 转译，写进 `mapFinishReasonToErrorType`):

```
'stop'                 → ok=true, 不填 errorType
'length'               → 'response_truncated'
'content_filter'       → 'response_filtered'
'tool_calls'(inconsistent) → 'provider_inconsistent'
'budget'               → 'budget'
'tool_failed'          → 'tool_failed'
'tool_unavailable'     → 'tool_unavailable'
'max_rounds'           → 'max_rounds'
'empty'                → 'empty_response'
'error'(LLM 调用挂了)  → 'llm_failed'
```

**L1 → L3**: `LlmFailureReason` 只在 `errorMessage` 字符串里附带（如 `errorMessage: 'rate_limit: <原文>'`），不映射回 L3 枚举。`errorType: 'llm_failed'` 统一兜底。

**spawner 层独占**(不经过 mini-loop):
- `cancelled` — parentSignal aborted
- `failed` — 兜底未知异常
- `busy` — concurrentByTurn 限流命中
- `unknown_type` — registry.get(type) 返回 undefined

#### R-1.1 扩 contract V1

`src/application/contracts/subagent-events.ts`:

```ts
export type SubAgentErrorType =
  | 'cancelled' | 'failed' | 'busy' | 'unknown_type'
  | 'max_rounds' | 'budget' | 'tool_failed' | 'tool_unavailable'
  | 'llm_failed' | 'response_truncated' | 'response_filtered'
  | 'provider_inconsistent' | 'empty_response'

export interface SubAgentStartedV1 {
  parentTurnId: string
  parentSessionId: string
  subSessionId: string
  type: string
  description: string         // task tool 的 description 入参, UI 展示用
  callId: string
  ts: number
}

export interface SubAgentCompletedV1 {
  parentTurnId: string
  parentSessionId: string
  subSessionId: string
  type: string
  callId: string
  ok: boolean
  usage: { input: number; output: number }
  finalText?: string
  errorMessage?: string       // 失败原因(plain string, 不含 XML 标签)
  errorType?: SubAgentErrorType  // L3 业务层枚举, 非 L2 finishReason
  finishReason?: string       // L2 原始 finishReason, 调试/归因用
  durationMs: number          // started → completed 毫秒差
  ts: number
}

/** innerToolCall 进度事件 */
export interface SubAgentProgressV1 {
  parentTurnId: string
  parentSessionId: string
  subSessionId: string
  callId: string              // 父 turn 里 task tool 的 callId
  innerCallId: string         // 本次 inner tool call 唯一 id
  toolName: string
  phase: 'start' | 'end'
  ok?: boolean                // phase='end' 必填
  durationMs?: number         // phase='end' 必填
  ts: number
}
```

注册到 `src/application/contracts/events/contracted-event-map.ts`:
```ts
'subagent.started': SubAgentStartedV1
'subagent.completed': SubAgentCompletedV1
'subagent.progress': SubAgentProgressV1   // 新增
```

#### R-1.2 SubAgentRunInput 加 description，task-tool 透传

`src/extensions/sub-agent/types.ts`:
```ts
export interface SubAgentRunInput {
  type: string
  prompt: string
  description: string         // 新增
  parentSessionId: string
  parentTurnId: string
  parentCallId: string
  parentSignal: AbortSignal
}
```

`task-tool.ts` execute:
```ts
return deps.runSubAgent({
  type: params.subagent_type as string,
  prompt: params.prompt as string,
  description: params.description as string,
  parentSessionId: ctx.sessionId,
  parentTurnId: ctx.turnId,
  parentCallId: ctx.callId,
  parentSignal: ctx.signal,
})
```

#### R-1.3 runner-spawner emit 修复 + 转译函数

新增 `mapFinishReasonToErrorType`:

```ts
function mapFinishReasonToErrorType(fr: string): SubAgentErrorType | undefined {
  switch (fr) {
    case 'length': return 'response_truncated'
    case 'content_filter': return 'response_filtered'
    case 'tool_calls': case 'inconsistent': return 'provider_inconsistent'
    case 'budget': return 'budget'
    case 'tool_failed': return 'tool_failed'
    case 'tool_unavailable': return 'tool_unavailable'
    case 'max_rounds': return 'max_rounds'
    case 'empty': return 'empty_response'
    case 'error': return 'llm_failed'
    default: return undefined  // stop → ok=true, 不填 errorType
  }
}
```

Started emit (补 `description`):
```ts
const startedAt = Date.now()
deps.bus.emit('subagent.started', {
  parentTurnId: input.parentTurnId,
  parentSessionId: input.parentSessionId,
  subSessionId,
  type: input.type,
  description: input.description,
  callId: input.parentCallId,
  ts: startedAt,
})
```

成功路径 emit (补 `parentSessionId` + `durationMs`):
```ts
deps.bus.emit('subagent.completed', {
  parentTurnId: input.parentTurnId,
  parentSessionId: input.parentSessionId,
  subSessionId,
  type: input.type,
  callId: input.parentCallId,
  ok: true,
  usage: typed.usage,
  finalText: typed.finalText,
  finishReason: typed.finishReason,
  durationMs: Date.now() - startedAt,
  ts: Date.now(),
})
```

失败路径 emit (补 `parentSessionId` + `errorMessage` + `errorType` + `durationMs`):
```ts
let errorType: SubAgentErrorType
let errorMessage: string

if (err instanceof Error && err.name === 'AbortError') {
  errorType = 'cancelled'
  errorMessage = err.message
} else if (typed) {
  // mini-loop 返回了结果但有错误 finishReason
  errorType = mapFinishReasonToErrorType(typed.finishReason) ?? 'failed'
  errorMessage = typed.finalText
} else {
  errorType = 'failed'
  errorMessage = msg
}

deps.bus.emit('subagent.completed', {
  parentTurnId: input.parentTurnId,
  parentSessionId: input.parentSessionId,
  subSessionId,
  type: input.type,
  callId: input.parentCallId,
  ok: false,
  usage: typed?.usage ?? { input: 0, output: 0 },
  finalText: typed?.finalText ?? '',
  errorType,
  errorMessage,
  finishReason: typed?.finishReason,
  durationMs: Date.now() - startedAt,
  ts: Date.now(),
})
```

#### R-1.4 验收 grep

```
rg "parentSessionId:\s*input\.parentSessionId" src/extensions/sub-agent/runner-spawner.ts  → ≥2 hits (started + completed 两路径)
rg "durationMs:" src/extensions/sub-agent/runner-spawner.ts                                 → ≥2 hits
rg "subagent\.progress" src/application/contracts/                                          → ≥1 hit
rg "mapFinishReasonToErrorType" src/extensions/sub-agent/runner-spawner.ts                  → ≥1 hit
```

---

### R-2 — 删除假的 `startEmitted` 配对约束

**问题**: Q2 假设 `bus.emit` 同步可抛，引入 `startEmitted` 状态机配对约束。实际 ContractBus 是 fire-and-forget，subscriber 异常被隔离，`try/catch` 永远走不到。

**修复**: 承认 bus.emit 是 best-effort，删 try/catch 与 startEmitted。

```ts
// runner-spawner.ts
const startedAt = Date.now()
deps.bus.emit('subagent.started', { ... })  // best-effort, no try/catch

try {
  const result = await deps.spawner.run({ ... })
  deps.bus.emit('subagent.completed', { ok: true, ... })
  return typed.finalText
} catch (err) {
  deps.bus.emit('subagent.completed', { ok: false, errorMessage, errorType, ... })
  return `<sub-agent-error type="${tag}" reason="${escapeXmlAttr(msg)}" />`
} finally {
  release(input.parentTurnId)
}
```

**为什么不把 ContractBus 改成 async**: 横切 200+ emit 点的大手术，远超 M3 范围。subscriber 异常本就该 subscriber 自己 try/catch。

**验收**:
```
rg "startEmitted" src/extensions/sub-agent/  → 0 hits
```

---

### R-3 — dispatchTool ToolContext 用 sub session/turn id + 语义变更防御

**问题**: `runner-spawner.ts:113` 给 dispatched tool 的 ctx 用 parentSessionId / parentTurnId，违反原 spec I-10（permission deny-list 按 sub session 隔离）。

**修复**:
```ts
const tctx: ToolContext = {
  signal: input.parentSignal,
  environment: { cwd: deps.agentDir },
  sink: createToolSink() as unknown as ToolContext['sink'],
  sessionId: subSessionId,           // ← 直接调用者的 session id
  turnId: subTurnId,                  // ← 直接调用者的 turn id
  callId: call.callId,
  source,                             // source 已携带 parent 追溯信息
}
```

**语义变更声明 (Semantic break notice)**: 此次修复改变了 `ToolContext.sessionId` 的语义契约——从"调用链的根 session id"改为"直接调用者的 session id"。任何依赖"sessionId 等于根 session"的代码必须改用 `ctx.source` 显式判断。当前 grep 审计结果为零依赖，改动安全。

#### 4 项防御性动作

**1. ToolContext.sessionId 加 JSDoc** (`src/application/ports/tool-context.ts`):

```ts
export interface ToolContext {
  /**
   * Session id of the **direct caller** of this tool.
   * - Parent agent call → parent session id
   * - Sub-agent inner call → sub session id (e.g. 'sub:t1:01XYZ...')
   *
   * If you need to key state by the user-facing top-level session,
   * use `ctx.source.kind === 'subagent'` to detect sub-agent context
   * and consult the source for ancestry. Do NOT assume sessionId is stable
   * across sub-agent boundaries.
   */
  sessionId: string
  // ...
}
```

**2. ToolCallSource subagent 分支扩 parent 信息** (`src/application/ports/tool-context.ts`):

```ts
export type ToolCallSource =
  | { kind: 'parent' }
  | {
      kind: 'subagent'
      subAgentType: string
      subAgentCallId: string
      parentSessionId: string  // 反查根 session 的唯一通道
      parentTurnId: string      // 反查根 turn 的唯一通道
    }
```

**3. Unit test 锁死语义** — I-6 invariant (见 §6)

**4. Edge case 文档** — tool 实现者若需根 session，强制走 `ctx.source.parentSessionId`，不得假设 `ctx.sessionId` 是根（§7）

**验收**:
```
rg "sessionId:\s*subSessionId" src/extensions/sub-agent/runner-spawner.ts  → ≥1 hit
rg "turnId:\s*subTurnId" src/extensions/sub-agent/runner-spawner.ts        → ≥1 hit
rg "parentSessionId" src/application/ports/tool-context.ts                 → ≥1 hit (source 新字段)
```

---

## 2. 安全 Invariants 硬规则

### S-1 — `ask_user_question` 运行时硬规则

原 spec I-2: `ask_user_question` 在所有 builtin sub-agent 的白名单中**永远不出现**（hand-off 模式无人类回路）。

`src/extensions/sub-agent/registry.ts`:
```ts
const ALWAYS_FORBIDDEN_TOOLS = ['ask_user_question'] as const

register(desc: SubAgentDescriptor): void {
  for (const forbidden of ALWAYS_FORBIDDEN_TOOLS) {
    if (desc.allowedToolNames.includes(forbidden)) {
      throw new Error(
        `Sub-agent "${desc.type}" cannot allow "${forbidden}" — ` +
        `hand-off mode has no human loop`,
      )
    }
  }
  // ... 原有 builtin override 检查
}
```

**验收**:
```
rg "ALWAYS_FORBIDDEN_TOOLS" src/extensions/sub-agent/registry.ts  → ≥1 hit
```
单测: 注册 `allowedToolNames: ['ask_user_question']` 的 descriptor 抛错。

---

### S-2 — Sub 嵌套 sub 硬规则（双闸门）

原 spec D-7: Sub 嵌套 sub 禁止。

**闸门 1** — dispatchTool closure (`runner-spawner.ts`):
```ts
dispatchTool: async (call) => {
  if (call.name === 'task') {
    return { success: false, error: { code: 'TOOL_NOT_ALLOWED' as const, message: 'sub-agent cannot dispatch task tool (no nested sub-agents)' } }
  }
  if (!desc.allowedToolNames.includes(call.name)) { ... }
  // ...
}
```

**闸门 2** — task-tool execute 入口 (`task-tool.ts`):
```ts
async execute(ctx, params) {
  if (ctx.source?.kind === 'subagent') {
    throw new Error('task tool cannot be called from inside a sub-agent')
  }
  // ...
}
```

**验收**:
```
rg "name === 'task'" src/extensions/sub-agent/runner-spawner.ts                  → ≥1 hit
rg "ctx\.source\?\.kind === 'subagent'" src/extensions/sub-agent/task-tool.ts    → ≥1 hit
```

---

### S-3 — `modelHint` 闭包注入，同 run 内不可变

原 spec D-13: descriptor.modelHint → provider 适配模型档位。

**方案**: 闭包注入（非 frame 协议改动）。`sub-agent/index.ts` 在构造 runner 时把 `desc.modelHint` 消化掉，worker 完全不感知 model 概念。

`src/extensions/sub-agent/index.ts`:
```ts
function resolveModel(hint: SubAgentDescriptor['modelHint']): string | undefined {
  switch (hint) {
    case 'fast':   return 'claude-haiku-4-5-20251001'  // 可配化，先写死
    case 'strong': return undefined                      // 走 provider 默认
    default:       return undefined
  }
}

// 注入给 createSpawnerSubAgentRunner
const runSubAgent = createSpawnerSubAgentRunner({
  ...,
  resolveModel,
})
```

`runner-spawner.ts` 内，拿到 desc 后固化 model:
```ts
const model = deps.resolveModel(desc.modelHint)
const ctx: JobContext = {
  chatComplete: async (req) => deps.chatComplete({ ...req, model: req.model ?? model, signal: input.parentSignal }),
  // ...
}
```

**I-9**: 同一 sub-agent run 内，所有 chatComplete 调用必须使用同一个 model（由 `desc.modelHint` 在 runner 构造时一次性决定），mini-loop 不得有动态 model 切换逻辑。

**验收**:
```
rg "resolveModel" src/extensions/sub-agent/index.ts            → ≥1 hit
rg "req\.model \?\? model" src/extensions/sub-agent/            → ≥1 hit
rg "model:" src/extensions/sub-agent/mini-turn-loop.ts          → 0 hits (worker 不直接传 model)
```
单测: descriptor.modelHint='fast' → chatComplete 收到的 model 来自 resolveModel。

---

### S-4 — 空 round 计数器

原 spec edge case 5: Sub 连续多 round 都不输出文本也不调工具，第 2 个空 round 视为完成。

`mini-turn-loop.ts`:
```ts
let consecutiveEmptyRounds = 0
const MAX_EMPTY_ROUNDS = 2

for (let round = 0; round < maxRounds; round++) {
  // ... chatComplete

  const isEmpty = !resp.content && (!resp.toolCalls || resp.toolCalls.length === 0)
  if (isEmpty) {
    consecutiveEmptyRounds++
    if (consecutiveEmptyRounds >= MAX_EMPTY_ROUNDS) {
      return {
        finalText: `<sub-agent-warning type="empty_rounds" rounds="${consecutiveEmptyRounds}"></sub-agent-warning>`,
        usage: totalUsage, toolCallCount, rounds: round + 1,
        finishReason: 'empty_rounds',
      }
    }
    messages.push({ role: 'user', content: 'You produced no output. Either call a tool or output your final answer.' })
    continue
  }
  consecutiveEmptyRounds = 0
  // ... 原有处理
}
```

**验收**:
```
rg "consecutiveEmptyRounds" src/extensions/sub-agent/mini-turn-loop.ts  → ≥1 hit
```
单测: 连续 2 个 empty round → 终止 with finishReason='empty_rounds'。

---

## 3. 进度链路 — IPC Frame → Bus Event

### P-1 — 复用 progress IPC frame

`src/infrastructure/jobs/spawn-rpc/frame.ts` 已有 `progress` FrameKind。M3 在 sub-agent 场景下约定 payload 形状:

```ts
type SubAgentProgressFramePayload = {
  kind: 'sub-agent.inner-tool'
  innerCallId: string
  toolName: string
  phase: 'start' | 'end'
  ok?: boolean
  durationMs?: number
}
```

`kind` 字段做 discriminated union，允许未来其他 progress 类型共存。

### P-2 — JobContext.onProgress 接口

`src/application/ports/job-spawner.ts`:
```ts
export interface JobContext {
  invoke(req: InvokeRequest): Promise<InvokeResponse>
  chatComplete(req: ChatCompleteRequest): Promise<ChatCompleteResponse>
  dispatchTool(call: ToolCall): Promise<ToolDispatchResponse>
  log(level: 'info' | 'warn' | 'error', msg: string): void
  onProgress?(payload: Record<string, unknown>): void   // 新增
}
```

`spawn-worker-runtime.ts` 收到 `progress` frame 调 `ctx.onProgress?.(frame.payload)`。基础设施层只做 frame → callback 转发，**不直接 emit 业务 bus event**。

### P-3 — Worker 侧 emit progress

`mini-turn-loop.ts`:
```ts
interface MiniLoopDeps {
  ...
  progress?: (p: SubAgentProgressFramePayload) => void
}

// for loop 内，每个 tool call 包装 emit
for (const tc of resp.toolCalls) {
  toolCallCount++
  const innerCallId = `${deps.subTurnId}:${tc.id}`
  const startTs = Date.now()

  deps.progress?.({ kind: 'sub-agent.inner-tool', innerCallId, toolName: tc.name, phase: 'start' })

  const response = await dispatchTool({ name: tc.name, arguments: tc.arguments, callId: tc.id })

  deps.progress?.({ kind: 'sub-agent.inner-tool', innerCallId, toolName: tc.name, phase: 'end', ok: response.success, durationMs: Date.now() - startTs })

  // ... 原有 success/failure 处理
}
```

`worker-entry-subagent.ts` 把 progress callback 接到 frame writer:
```ts
const progress = (payload: SubAgentProgressFramePayload) => {
  writeFrame({ kind: 'progress', id: nextId(), payload })
}
runMiniTurnLoop({ ..., progress })
```

### P-4 — Parent 侧 closure 转 bus event

`runner-spawner.ts` ctx 构造时注入 onProgress:
```ts
ctx: {
  ...
  onProgress: (payload) => {
    if ((payload as { kind?: string }).kind !== 'sub-agent.inner-tool') return
    const p = payload as SubAgentProgressFramePayload
    deps.bus.emit('subagent.progress', {
      parentTurnId: input.parentTurnId,
      parentSessionId: input.parentSessionId,
      subSessionId,
      callId: input.parentCallId,
      innerCallId: p.innerCallId,
      toolName: p.toolName,
      phase: p.phase,
      ok: p.ok,
      durationMs: p.durationMs,
      ts: Date.now(),
    })
  },
}
```

业务事件名 / 字段映射全在 sub-agent extension，基础设施层零业务知识。

### P-5 — Dataplane 桥扩

`src/extensions/dataplane/index.ts`:
```ts
{ busEvent: 'subagent.progress', dpType: 'sub-agent.progress' },
```

`src/application/contracts/dataplane-event.ts`:
```ts
type DataPlaneEventType =
  | ...
  | 'sub-agent.started'
  | 'sub-agent.completed'
  | 'sub-agent.progress'
```

`src/extensions/frontend.lark/internal/data-plane-to-agent-event.ts` — 补 case 到 null 分支:
```ts
case 'sub-agent.started': case 'sub-agent.completed': case 'sub-agent.progress':
  return null;
```

### 验收

```
rg "subagent\.progress" src/extensions/sub-agent/                    → ≥1 hit
rg "sub-agent\.inner-tool" src/extensions/sub-agent/                 → ≥2 hits
rg "onProgress" src/application/ports/job-spawner.ts                 → ≥1 hit
rg "sub-agent\.progress" src/extensions/dataplane/                   → ≥1 hit
```

---

## 4. 可视化 — Widget `subagent.task`

### W-1 — Payload 与 declare module

新建 `src/extensions/sub-agent/widget-payloads.ts`:

```ts
import type { SubAgentErrorType } from '../../application/contracts/subagent-events'

export interface SubAgentInnerToolCall {
  readonly innerCallId: string
  readonly name: string
  readonly status: 'running' | 'ok' | 'error'
  readonly durationMs?: number
}

export interface SubAgentTaskPayload {
  readonly callId: string
  readonly subagentType: string
  readonly description: string
  readonly status: 'running' | 'ok' | 'failed' | 'cancelled'
  readonly subSessionId: string
  readonly innerToolCalls: ReadonlyArray<SubAgentInnerToolCall>
  readonly finalText?: string
  readonly usage?: { input: number; output: number }
  readonly errorMessage?: string
  readonly errorType?: SubAgentErrorType
  readonly durationMs?: number
}

declare module '../../application/contracts/widget-payload-map' {
  interface WidgetPayloadMap {
    'subagent.task': SubAgentTaskPayload
  }
}
```

### W-2 — BlockId 约定

```
`task:${parentTurnId}:${parentCallId}`
```

同一 task tool call 全生命周期共享一个 blockId，第一次 `append`，后续全 `replace`。

### W-3 — Widget Bridge (stateful subscriber + GC sweep)

新建 `src/extensions/sub-agent/widget-bridge.ts`:

GC 设计:
- 单 widget 寿命阈值: 30 min (从 `started.ts` 算)
- sweep 周期: 5 min (一个 setInterval 扫 Map)
- GC emit 必须用 `replace` mode + 同一 blockId
- extension shutdown 时 `clearInterval` 防泄漏

```ts
import { emitInlineBlock } from '../../application/contracts/widget-events'
import type { ContractBus } from '../../application/event-bus/contract-bus'
import type { Logger } from '../../application/ports/logger'
import type { SubAgentStartedV1, SubAgentCompletedV1, SubAgentProgressV1 } from '../../application/contracts/subagent-events'
import type { SubAgentTaskPayload, SubAgentInnerToolCall } from './widget-payloads'

const WIDGET_TIMEOUT_MS = 30 * 60 * 1000   // 30 min 单 widget 寿命
const SWEEP_INTERVAL_MS = 5 * 60 * 1000    // 5 min sweep 周期

interface BridgeEntry {
  payload: SubAgentTaskPayload
  parentSessionId: string
  parentTurnId: string
  startedAt: number
  blockId: string
}

export function attachWidgetBridge(bus: ContractBus, logger: Logger): () => void {
  const state = new Map<string, BridgeEntry>()  // key: callId

  function emit(entry: BridgeEntry, mode: 'append' | 'replace') {
    emitInlineBlock(bus, {
      sessionId: entry.parentSessionId,
      widget: 'subagent.task',
      payload: entry.payload,
      blockId: entry.blockId,
      mode,
    })
  }

  const sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [callId, entry] of state) {
      if (now - entry.startedAt > WIDGET_TIMEOUT_MS) {
        entry.payload = {
          ...entry.payload,
          status: 'failed',
          errorMessage: 'timeout: no completion received within 30min',
        }
        emit(entry, 'replace')
        state.delete(callId)
      }
    }
  }, SWEEP_INTERVAL_MS)

  const offStarted = bus.on('subagent.started', (e: SubAgentStartedV1) => {
    const blockId = `task:${e.parentTurnId}:${e.callId}`
    const payload: SubAgentTaskPayload = {
      callId: e.callId,
      subagentType: e.type,
      description: e.description,
      status: 'running',
      subSessionId: e.subSessionId,
      innerToolCalls: [],
    }
    state.set(e.callId, {
      payload, parentSessionId: e.parentSessionId, parentTurnId: e.parentTurnId,
      startedAt: e.ts, blockId,
    })
    emit(state.get(e.callId)!, 'append')
  })

  const offProgress = bus.on('subagent.progress', (e: SubAgentProgressV1) => {
    const entry = state.get(e.callId)
    if (!entry) {
      logger.warn('sub-agent.widget-bridge', `progress for unknown callId=${e.callId}`)
      return
    }
    let inner: ReadonlyArray<SubAgentInnerToolCall>
    if (e.phase === 'start') {
      inner = [...entry.payload.innerToolCalls, { innerCallId: e.innerCallId, name: e.toolName, status: 'running' }]
    } else {
      inner = entry.payload.innerToolCalls.map(it =>
        it.innerCallId === e.innerCallId
          ? { ...it, status: e.ok ? 'ok' : 'error', durationMs: e.durationMs }
          : it,
      )
    }
    entry.payload = { ...entry.payload, innerToolCalls: inner }
    emit(entry, 'replace')
  })

  const offCompleted = bus.on('subagent.completed', (e: SubAgentCompletedV1) => {
    const entry = state.get(e.callId)
    if (!entry) return
    const status: SubAgentTaskPayload['status'] = e.ok
      ? 'ok'
      : (e.errorType === 'cancelled' ? 'cancelled' : 'failed')
    entry.payload = {
      ...entry.payload,
      status,
      finalText: e.finalText,
      usage: e.usage,
      errorMessage: e.errorMessage,
      errorType: e.errorType,
      durationMs: e.durationMs,
    }
    emit(entry, 'replace')
    state.delete(e.callId)
  })

  return () => { offStarted(); offProgress(); offCompleted(); clearInterval(sweepTimer); state.clear() }
}
```

在 `src/extensions/sub-agent/index.ts` 的 `apply()` 启动:
```ts
const detachBridge = attachWidgetBridge(asContractBus(ctx.bus), ctx.logger)
return {
  // ...原有 provide/dispose
  dispose: () => { detachBridge(); registry.clear() },
}
```

### W-4 — TUI Projector

新建 `src/extensions/frontend.tui/widgets/impls/widget-subagent-task.tsx`:

折叠默认 (1 行):
```
▶ explore: 找 X 的位置 [running] (3 tools · 2.1s)
```

展开 (按 enter):
```
▼ explore: 找 X 的位置 [ok] (3 tools · 4.7s · 1.2k in / 0.8k out)
  ├ ✓ read         (320ms)
  ├ ✓ grep         (180ms)
  └ ✓ glob         (95ms)
  ───────────────
  Found 2 occurrences in src/foo.ts:34 and src/bar.ts:88...
  (truncated, see sub session sub:t1:01...XYZ)
```

颜色:
- running → cyan
- ok → green
- failed → red
- cancelled → gray

注册 `src/extensions/frontend.tui/widgets/widget-registry.ts`:
```ts
import '../../sub-agent/widget-payloads'      // side-effect import
import { widgetSubAgentTask } from './impls/widget-subagent-task'

const WIDGETS: WidgetMap = {
  // ...
  'subagent.task': widgetSubAgentTask,
}
```

### W-5 验收

```
rg "subagent\.task" src/extensions/sub-agent/widget-payloads.ts                                → ≥1 hit
rg "subagent\.task" src/extensions/frontend\.tui/widgets/widget-registry.ts                    → ≥1 hit
rg "attachWidgetBridge" src/extensions/sub-agent/index.ts                                      → ≥1 hit
```

---

## 5. Controlplane RPC

### PR 切分（4 → 5 PR）

**PR-1**: Bug fixes + safety invariants (~120 LOC)
**PR-2**: Progress chain + modelHint (~135 LOC，依赖 PR-1)
**PR-3**: Widget (~300 LOC，依赖 PR-1 + PR-2)
**PR-4**: Controlplane list + describe (~70 LOC，依赖 PR-1，可与 PR-3 并行 review)
**PR-5**: Controlplane invoke + 安全防护 (~80 LOC，依赖 PR-3 + PR-4)

```
PR-1 ──┬── PR-2 ── PR-3 ──┬── PR-5
       │                    │
       └── PR-4 ────────────┘  (PR-3 ∥ PR-4 可并行 review)
```

### C-1 — `subagent.list`

通过 capability 暴露 registry getter (`src/extensions/sub-agent/index.ts`):
```ts
capabilities: {
  'sub-agent.registry': () => registry,
  'sub-agent.runner': () => runner,
}
```

`src/extensions/controlplane/methods.ts`:
```ts
const getRegistry = () => {
  try { return ctx.extensions.get('sub-agent.registry') as SubAgentRegistry }
  catch { return null }
}

'subagent.list': async () => {
  const reg = getRegistry()
  if (!reg) return { agents: [] }
  return {
    agents: reg.list().map(d => ({
      type: d.type,
      description: d.description,
      allowedToolNames: [...d.allowedToolNames],
      source: d.source,
      maxRounds: d.maxRounds,
      maxTokensPerCall: d.maxTokensPerCall,
      maxTotalTokens: d.maxTotalTokens,
      lifetimeMs: d.lifetimeMs,
      modelHint: d.modelHint,
      // systemPrompt 明确不返回 (脱敏)
    })),
  }
}
```

### C-2 — `subagent.describe`

```ts
'subagent.describe': async (args: { type: string }) => {
  const reg = getRegistry()
  if (!reg) return { found: false }
  const d = reg.get(args.type)
  if (!d) return { found: false }
  return {
    found: true,
    agent: {
      type: d.type, description: d.description,
      allowedToolNames: [...d.allowedToolNames],
      source: d.source,
      maxRounds: d.maxRounds, maxTokensPerCall: d.maxTokensPerCall,
      maxTotalTokens: d.maxTotalTokens, lifetimeMs: d.lifetimeMs,
      modelHint: d.modelHint,
    },
  }
}
```

### C-3 — `subagent.invoke` (PR-5，调试旁路)

> 危险口子（绕开 LLM 直接 spawn sub-agent），仅在 `cfg.allowSubAgentDirectInvoke === true` 时注册。

**3 层防护**:

**P1 — config 层** (`src/infrastructure/config/schema.ts`):
```ts
const ConfigSchema = z.object({
  // ...
  /**
   * SECURITY: Allow direct sub-agent invocation via controlplane RPC,
   * bypassing the LLM tool-call gate. Intended for debugging only.
   * MUST remain false in production. Cannot be modified at runtime.
   */
  allowSubAgentDirectInvoke: z.boolean().default(false),
})
```

**P2 — handler 层** (闭包捕获启动值，防御运行时篡改):
```ts
const allowed = cfg.allowSubAgentDirectInvoke  // 闭包捕获
'subagent.invoke': async (args) => {
  if (!allowed) {
    throw new RpcError('SUBAGENT_INVOKE_DISABLED',
      'Direct sub-agent invocation is disabled. Enable via config (requires restart).')
  }
  // ...
}
```

**P3 — 启动日志 warn** (app bootstrap):
```ts
if (cfg.allowSubAgentDirectInvoke) {
  log.warn('SECURITY: allowSubAgentDirectInvoke=true. Direct RPC invocation enabled. Do not use in production.')
}
```

PR-5 内部范围锁死 5 项:
1. `Config.allowSubAgentDirectInvoke: boolean` schema 字段 + 默认 false
2. `makeSubAgentInvokeHandler` RPC handler (含闭包捕获 cfg)
3. 启动日志 warn (若 allowed=true)
4. 集成测试: 验证 allowed=false 时 RPC 返回 `SUBAGENT_INVOKE_DISABLED`
5. 审计 doc: `docs/security/subagent-invoke.md` 说明此开关用途与风险

**与 smoke test 的关系**: C-3 invoke 是 dev-tool，仅用于本地调试。CI 仍依赖 integration smoke test（走 LLM 触发路径）保证回归覆盖。C-3 不参与 CI。

### C-4 验收

```
rg "subagent\.list\|subagent\.describe" src/extensions/controlplane/methods.ts         → ≥2 hits
rg "sub-agent\.registry" src/extensions/sub-agent/index.ts                             → ≥1 hit
rg "systemPrompt" src/extensions/controlplane/                                         → 0 hits (脱敏)
rg "allowSubAgentDirectInvoke" src/infrastructure/config/schema.ts                     → ≥1 hit
rg "SUBAGENT_INVOKE_DISABLED" src/extensions/controlplane/                             → ≥1 hit
```

---

## 6. Invariants (M3 完整测试断言矩阵)

| # | Invariant | 测试位置 | 来源 |
|---|---|---|---|
| **I-1** | `subagent.started` payload 必含 `parentSessionId` 且等于 `input.parentSessionId` | unit: runner-spawner.test.ts | R-1 |
| **I-2** | `subagent.completed` payload 必含 `durationMs > 0` | unit: runner-spawner.test.ts | R-1 |
| **I-3** | 注册 `allowedToolNames: ['ask_user_question']` 的 descriptor 抛错 | unit: registry.test.ts | S-1 |
| **I-4** | sub-agent dispatchTool({ name: 'task' }) 返回 `TOOL_NOT_ALLOWED` | unit: runner-spawner.test.ts | S-2 |
| **I-5** | task-tool execute with `ctx.source.kind='subagent'` 抛错 | unit: task-tool.test.ts | S-2 |
| **I-6** | dispatchTool 的 `ToolContext.sessionId === subSessionId` (不等于 parentSessionId) | unit: runner-spawner.test.ts | R-3 |
| **I-7** | 连续 2 个 empty round → 终止 with `finishReason='empty_rounds'` | unit: mini-turn-loop.test.ts | S-4 |
| **I-8** | contract `SubAgentCompletedV1.errorType` 取值必须在 12 种枚举内（类型层保证），不可直接传 mini-loop `finishReason` 原值 | type-check (TS) | R-1 |
| **I-9** | 同一 sub-agent run 内，所有 `chatComplete` 调用 model 不变（由 `desc.modelHint` 在 runner 构造时一次性决定） | unit: runner-spawner.test.ts | S-3 |
| **I-10** | `ctx.source.kind === 'subagent'` 时，`source.parentSessionId` 与 `input.parentSessionId` 完全相等 | unit: runner-spawner.test.ts | R-3 |
| **I-11** | widget bridge GC 触发的 failed emit 必须保持原 blockId + replace mode | unit: widget-bridge.test.ts | W-3 |
| **I-12** | `allowSubAgentDirectInvoke=false` 时，`subagent.invoke` RPC 返回 `SUBAGENT_INVOKE_DISABLED` | unit: controlplane.test.ts | C-3 |
| **I-13** | `subagent.progress` 永远成对（同 innerCallId 必有 start + end） | unit: mini-turn-loop.test.ts | P-3 |
| **I-14** | widget-bridge 在 completed 后必从 state.delete，GC timer cancel | unit: widget-bridge.test.ts | W-3 |
| **I-15** | integration smoke test 完整验证 started → 2× progress → completed | integration: sub-agent-spawn-smoke.test.ts | P-3 |
| **I-16** | `subagent.list` 返回值不含 `systemPrompt` 字段 | unit: controlplane.test.ts | C-4 |
| **I-17** | builtin 不可被覆盖，extension agent 可被覆盖但 warn | unit: registry.test.ts | 已存在 |
| **I-18** | parent abort 在 inner tool 执行中 → response.success=false → progress end(ok=false) → completed(cancelled) | unit: runner-spawner.test.ts | edge |

---

## 7. Edge Cases (行为约定)

1. **Worker 在 progress.end 之前崩溃**: widget 显示对应 innerToolCall 永远 status='running' —— 接受。completed(ok=false) 到达时 widget 整体置 'failed'，innerToolCall 的残留 running 状态用户不会展开看。
2. **Parent abort 在 inner tool 执行中**: dispatchTool 被 signal 中断 → response.success=false → mini-loop emit progress end(ok=false) → completed(cancelled)。3 个事件顺序保持。
3. **同 callId 重复 started** (spawner 重试场景): widget-bridge 检测到 map 已有该 callId → 覆盖 (replace 模式)，不警告。
4. **`subagent.progress` 在 `subagent.started` 之前到达**: 理论上不可能（同进程 emit 顺序保证），若发生 → widget-bridge 丢弃 progress 并 warn 日志。
5. **innerCallId 冲突**: mini-loop 用 `${subTurnId}:${tc.id}` 拼接保证 sub-turn 内唯一。
6. **未 completed 的 widget (30 分钟)**: GC sweep 触发 `replace status='failed' errorMessage='timeout (no completion received within 30min)'` 收尾。
7. **`subagent.invoke` RPC 在 cfg.allowSubAgentDirectInvoke=false 时**: method 不注册，调用返回 `Method not found` 或 `SUBAGENT_INVOKE_DISABLED`。
8. **modelHint 不在映射字典中**: `resolveModel` 返回 undefined → chatComplete 用 provider 默认 model，记 debug 日志。
9. **Sub-agent 内部 LLM 拒绝任何工具，只输出文本**: 正常 stop 路径，emit completed(ok=true)，widget status='ok'。
10. **Sub 触达 maxRounds**: mini-loop 返回 `<sub-agent-warning type="max_rounds_reached">...`，runner-spawner 把字符串当 finalText 返回，emit completed(ok=true)，errorType='max_rounds'。
11. **重启场景**: agent 重启后，未完成的 sub-agent widget 在 TUI 上永久显示 `running` 状态（无 source of truth 可恢复）。用户可发起新 task tool 调用（新 callId），不会与旧 widget 冲突。**不做 orphan sweep**，因为状态不可知 —— 任何标注都是编造。
12. **多前端一致性**: 同一 session 的 TUI 与 Lark frontend 对 sub-agent widget 显示不一致（TUI 渲染，Lark drop）。M3 显式接受此差异。
13. **Session detach 时 GC 触发 emit**: 不检查 session 是否 attached。dataplane eventLog 是 session-scoped，GC 触发的 failed emit 写入 eventLog 后，任何后续 attach/重连的 frontend 都能看到这个收尾状态。**这正是想要的行为**。
14. **Tool 实现者需根 session**: 强制走 `ctx.source.parentSessionId`，不得假设 `ctx.sessionId` 是根。

---

## 8. 显式不在本 spec 范围

| 项 | 说明 |
|---|---|
| **Sub session id 真正写 session store** | 当前 sub session 仅是逻辑标识，不入库。若未来需要 sub-agent 跨 turn 持久化，另立 spec |
| **Sub usage 写入父 turn 的 usage tag** | 涉及 trace/usage 子系统改造，独立 spec |
| **Mini-loop 内的 tool wave 并行** | 当前 mini-loop 串行执行 tool call |
| **Lark 前端渲染 sub-agent** | data-plane-to-agent-event.ts 当前返回 null，M3 不处理 |
| **Sub-agent 的 trace 串联可视化** | 依赖 trace extension 适配，另立 spec |
| **RPC 热改 allowSubAgentDirectInvoke** | 安全开关只能通过部署变更，永不实现 |
| **跨 round 动态切 model** | mini-loop 内不切换 model，由 desc.modelHint 一次性决定 |

---

## 9. 实施顺序 (5 PR，15 + 6 Step)

```
Phase 1 — Bug fixes + 安全 invariants (PR-1)
Step 1   | R-1.0 错误三层 + R-1.1 contract V1 扩展                     | ~£45 LOC | 类型前置
Step 2   | R-1.2 task-tool description 透传 + R-1.3 runner-spawner emit 修复 + 转译函数 | ~60 LOC
Step 3   | R-2 删 startEmitted 状态机                                     | ~-15 LOC
Step 4   | R-3 dispatchTool ToolContext 用 subSessionId + source 扩字段 + JSDoc | ~+20 LOC
Step 5   | S-1 registry ALWAYS_FORBIDDEN_TOOLS                           | ~+15 LOC
Step 6   | S-2 task='task' dispatchTool 拒 + task-tool ctx.source 守卫     | ~+10 LOC
Step 7   | S-4 空 round 计数器 (MAX_EMPTY_ROUNDS=2)                     | ~+25 LOC

Phase 2 — 进度链路 (PR-2，依赖 PR-1)
Step 8   | P-2 JobContext.onProgress 接口 + spawn-worker-runtime progress 转发 | ~+30 LOC
Step 9   | P-3 mini-loop progress emit + worker-entry-subagent callback     | ~+40 LOC
Step 10  | P-4 runner-spawner onProgress → bus.emit('subagent.progress')    | ~+30 LOC
Step 11  | P-5 dataplane + dataplane-event.ts 加 'sub-agent.progress'       | ~+10 LOC
Step 12  | S-3 modelHint 闭包注入 (resolveModel + runner-spawner 固化)     | ~+15 LOC

Phase 3 — 可视化 (PR-3，依赖 PR-1 + PR-2)
Step 13  | W-1/W-2/W-3 widget-payloads + widget-bridge + sub-agent index 启动 + GC sweep | ~+180 LOC
Step 14  | W-4 TUI widget-subagent-task.tsx + widget-registry 注册               | ~+130 LOC

Phase 4 — Controlplane RPC (PR-4，依赖 PR-1，与 PR-3 可并行)
Step 15  | C-1/C-2 sub-agent capability + subagent.list/describe                | ~+70 LOC

Phase 5 — Controlplane Invoke (PR-5，依赖 PR-3 + PR-4)
Step 16  | C-3 subagent.invoke + Config.allowSubAgentDirectInvoke schema         | ~+40 LOC
Step 17  | C-3 handler 闭包捕获 + 启动 warn + integration test + security doc    | ~+40 LOC
```

---

## 10. 文件清单

新增:
- `src/extensions/sub-agent/widget-payloads.ts`
- `src/extensions/sub-agent/widget-bridge.ts`
- `src/extensions/frontend.tui/widgets/impls/widget-subagent-task.tsx`
- `tests/extensions/sub-agent/widget-bridge.test.ts`
- `tests/unit/controlplane/subagent-list.test.ts`

修改:
- `src/application/contracts/subagent-events.ts` (扩 V1 + SubAgentProgressV1 + SubAgentErrorType)
- `src/application/contracts/events/contracted-event-map.ts` (注册 progress)
- `src/application/contracts/dataplane-event.ts` (加 sub-agent.progress)
- `src/application/ports/job-spawner.ts` (JobContext.onProgress)
- `src/application/ports/tool-context.ts` (sessionId JSDoc + source 扩 parent 字段)
- `src/extensions/sub-agent/types.ts` (SubAgentRunInput.description)
- `src/extensions/sub-agent/registry.ts` (ALWAYS_FORBIDDEN_TOOLS)
- `src/extensions/sub-agent/runner-spawner.ts` (R-1/R-2/R-3/S-2/P-4 + mapFinishReasonToErrorType)
- `src/extensions/sub-agent/task-tool.ts` (透传 description + ctx.source 守卫)
- `src/extensions/sub-agent/mini-turn-loop.ts` (S-4 空 round + P-3 progress emit)
- `src/extensions/sub-agent/worker-entry-subagent.ts` (progress callback 接入)
- `src/extensions/sub-agent/index.ts` (attachWidgetBridge + capabilities + resolveModel)
- `src/infrastructure/jobs/spawn-worker-runtime.ts` (progress frame 转 onProgress)
- `src/infrastructure/config/schema.ts` (allowSubAgentDirectInvoke)
- `src/extensions/dataplane/index.ts` (register subagent.progress)
- `src/extensions/controlplane/methods.ts` (注册 subagent.list/describe + 条件 invoke)
- `src/extensions/frontend.lark/internal/data-plane-to-agent-event.ts` (case 补 null)
- `src/extensions/frontend.tui/widgets/widget-registry.ts` (side-effect import + WIDGETS)

测试扩展:
- `tests/unit/sub-agent/runner-spawner.test.ts` (I-1/I-2/I-4/I-6/I-9/I-10/I-18)
- `tests/unit/sub-agent/mini-turn-loop.test.ts` (I-7/I-13)
- `tests/extensions/sub-agent/registry.test.ts` (I-3)
- `tests/extensions/sub-agent/task-tool.test.ts` (I-5)
- `tests/integration/sub-agent-spawn-smoke.test.ts` (I-15 — 加 progress 链路验证)

---

## 11. References

- M2 原始进程隔离 spec: `docs/superpowers/specs/2026-05-29-sub-agent-process-isolation.md`
- M2 follow-up fixes (Q1-Q8): `docs/superpowers/specs/2026-06-01-sub-agent-m2-followup-fixes.md`
- 原始 sub-agent 设计: `docs/superpowers/specs/2026-05-24-sub-agent-design.md`
- WidgetPayloadMap 模式参考: `src/extensions/memory/widget-payloads.ts`
- Dataplane 桥参考: `src/extensions/dataplane/index.ts`
- Controlplane methods 参考: `src/extensions/controlplane/methods.ts`
