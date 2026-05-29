# Spec: Sub-Agent Process Isolation (M2 Refactor)

> **Status**: Ready (grilled — 7 design decisions resolved)
> **Predecessor**: `src/extensions/sub-agent/*` (M1 in-process implementation)
> **Goal**: 把 sub-agent 从"复用 parent kernel 跑 runTurnUsecase"重构为"独立子进程隔离 + tool 回调 parent",彻底解决 prompt 上下文污染、并发 turnId 冲突、maxRounds 失效等 M1 遗留问题。

---

## 0. M1 实现的根本问题(回顾)

| 问题 | 严重度 | 根因 |
|---|---|---|
| 隔离不彻底 | **P0** | sub-agent 跑 `runTurnUsecase` 时,parent 的 `transformPrompt` hook(identity / memory / skills)仍然介入,导致 sub-agent 的 `systemPrompt` 与 parent agent identity 双重叠加 |
| `maxRounds` 不生效 | **P0** | 未传 `maxIterations`,所有 sub-agent 都用 default 10 轮 |
| `turnId` 并发冲突 | **P0** | `${parentTurnId}#sub` 在并行 task 时多个 sub-agent 共用同一 turnId,trace / 事件流污染 |
| `subagent_type.enum` 硬编码 | P1 | extension 注册的新 type 不出现在 LLM 看到的 schema |
| `maxOutputTokens` 语义混淆 | P1 | 命名像 budget,实际是 per-call max_tokens |
| Zero e2e 覆盖 | P1 | 任何上述退化无信号 |

**M2 目标**: 进程隔离 + 修掉所有 M1 P0/P1。

---

## 1. 架构总览

```
┌────────────────────────── parent kernel ──────────────────────────┐
│                                                                    │
│   tool catalog ──► [task tool] ──► SubAgentRunner (bun-spawn)     │
│                                              │                     │
│   provider.llm  ◄──── chatComplete ──────────┤                     │
│                                              │   stdio NDJSON      │
│   tool catalog  ◄──── tool-call ─────────────┤   bidirectional     │
│   (parent's)     tool-result ───────────────►│   (spawn-rpc/frame) │
│                                              │                     │
└──────────────────────────────────────────────┼─────────────────────┘
                                               │
                                  ┌────────────▼──────────────┐
                                  │   sub-agent worker process│
                                  │                            │
                                  │   mini turn-runner loop    │
                                  │   ├ chatComplete (IPC)     │
                                  │   ├ tool dispatch (IPC)    │
                                  │   └ NO identity/memory/    │
                                  │     skills/evolution       │
                                  │                            │
                                  └────────────────────────────┘
```

**核心隔离原则**:
1. worker 进程**只加载** sub-agent 自己的 systemPrompt + descriptor,**不加载** parent 的任何 transformPrompt 扩展
2. worker 调 LLM → 通过 IPC 回 parent 的 `ProviderChat.complete`(复用 token、复用 trace 链路)
3. worker 调 tool → 通过 IPC 回 parent 的 tool catalog(因为工具状态在 parent 的文件系统/MCP 连接里)
4. parent 在 IPC 边界做白名单校验:LLM purpose 白名单 + tool name 白名单

---

## 2. 协议扩展:`spawn-rpc/frame.ts`

### 2.1 新增 FrameKind

```diff
 export type FrameKind =
   | 'init'
   | 'invoke-req'
   | 'invoke-resp'
   | 'result'
   | 'log'
   | 'shutdown'
   | 'error'
+  | 'chat-req'         // worker → parent: LLM chat call (tool-capable)
+  | 'chat-resp'        // parent → worker: LLM chat response
+  | 'chat-error'       // parent → worker: LLM chat failed
+  | 'tool-call-req'    // worker → parent: 调用 parent 的 tool catalog
+  | 'tool-call-resp'   // parent → worker: tool 执行结果(成功/错误)
+  | 'progress'         // worker → parent: 中间状态(给 UI 实时反馈,可选)
```

### 2.2 新 frame payload schemas

```ts
// chat-req (worker → parent)
interface ChatRequestPayload {
  purpose: string                       // "subagent.run.<type>"
  messages: Array<{ role: string; content: string }>
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  maxTokens?: number
  signal?: boolean                      // abort flag
}

// chat-resp (parent → worker)
interface ChatResponsePayload {
  content: string
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter'
  usage: { input: number; output: number }
}

// chat-error (parent → worker)
interface ChatErrorPayload {
  code: 'PURPOSE_NOT_ALLOWED' | 'PROVIDER_FAIL' | 'RATE_LIMITED' | 'TIMEOUT'
  message: string
}

// tool-call-req (worker → parent)
interface ToolCallRequestPayload {
  name: string                       // tool name,必须在 sub-agent allowedToolNames 内
  arguments: Record<string, unknown> // raw args from LLM
  callId: string                     // LLM-generated tool call id
}

// tool-call-resp (parent → worker)
interface ToolCallResponsePayload {
  success: boolean
  result?: unknown                   // tool execute return value (success)
  error?: {                          // (failure)
    code: 'TOOL_NOT_ALLOWED' | 'TOOL_NOT_FOUND' | 'TOOL_EXEC_FAIL'
    message: string
  }
}

// progress (worker → parent,可选)
interface ProgressPayload {
  kind: 'round-started' | 'round-completed' | 'tool-starting' | 'text-delta'
  data: Record<string, unknown>
}
```

### 2.3 协议版本协商

`v: 1` 保持不变。Worker 端读取 init frame 时通过 `config.protocolFeatures` 显式告知 parent 是否启用新通道——老 worker(evolution / memory)不感知该字段,parent 也不会发 `chat-req`/`tool-call-req` frame 给它们。**完全向后兼容。**

---

## 3. 协议升级:`JobContext` 新增 `chatComplete`

> **Design decision (Q1):** Alt 1 — 不污染 `InvokeRequest`/`InvokeResponse`(保持 tool-free),新增独立方法。

### 3.1 修改 `src/application/ports/job-spawner.ts`

```diff
+export interface ChatCompleteRequest {
+  purpose: string
+  messages: Array<{ role: string; content: string }>
+  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
+  maxTokens?: number
+  signal?: AbortSignal
+}
+
+export interface ChatCompleteResponse {
+  content: string
+  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
+  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter'
+  usage: { input: number; output: number }
+}
+
 export interface JobContext {
   invoke: InvokeFn
+  chatComplete?: (req: ChatCompleteRequest) => Promise<ChatCompleteResponse>
   log?: (level: 'info' | 'warn' | 'error', msg: string) => void
 }
```

**Rationale:** `ProviderInvoke.call` 是设计为 tool-free 的单轮 LLM 调用路径。把 optional `tools`/`toolCalls` 字段打上去意味着 evolution `tier0`/`tier2` reviewer 和 memory extractor 的类型契约携带其从不使用的字段。`chatComplete` 是独立方法,名字告诉 worker 它命中哪条 provider 路径,无需 adapter 改动(`ProviderChat.complete` 已然返回 `toolCalls`)。

### 3.2 Parent 端路由

```diff
 const PURPOSE_WHITELIST = new Set([
   'evolution.review.tier0',
   'evolution.review.tier2',
   'memory.extract',
   'memory.contradiction',
 ])
+
+const CHAT_PURPOSE_WHITELIST = new Set([
+  'subagent.run.explore',
+  'subagent.run.plan',
+  'subagent.run.general-purpose',
+])
```

`BunSpawnJobSpawner` frame loop 新增:

```ts
case 'chat-req':
  await this.handleChatRequest(frame, child.stdin, opts.ctx, jobType, spawnId)
  break
case 'tool-call-req':
  await this.handleToolCall(frame, child.stdin, opts.ctx, jobType, spawnId)
  break
case 'progress':
  this.relayProgress(frame, jobType)
  break
```

`handleChatRequest`: 校验 purpose ∈ CHAT_PURPOSE_WHITELIST → 调用 `ProviderChat.complete(req)` → 返回 `chat-resp`。

**Whitelist 采用前缀模式:** extension 注册新 sub-agent type 后,自动匹配前缀 `"subagent.run."`。

### 3.3 Worker 端适配:`spawn-worker-runtime.ts`

```diff
 export interface WorkerContext {
   invoke(req): Promise<InvokeResponse>
+  chatComplete?(req: ChatCompleteRequest): Promise<ChatCompleteResponse>
   log(level, msg): void
 }
```

Worker runtime 维护 `pendingChat` Map(与 `pendingInvoke` 并行),暴露 `ctx.chatComplete` 给 worker handler。

---

## 4. Worker 端实现

### 4.1 Worker 入口:`worker-entry-subagent.ts`

> **Design decision (Q5):** static import + `JOB_WORKER_ENTRY` guard。

```ts
// src/extensions/sub-agent/worker-entry-subagent.ts
import type { JobContext } from '../../application/ports/job-spawner'
import type { ChatCompleteRequest, ChatCompleteResponse } from '../../application/ports/job-spawner'
import { runWorker } from '../../infrastructure/jobs/spawn-worker-runtime'
import { runMiniTurnLoop } from './mini-turn-loop'
import type { SubAgentDescriptor } from './types'
import type { ToolCallHandler } from './mini-turn-loop'

interface SubAgentJobInput {
  descriptor: SubAgentDescriptor
  userPrompt: string
  subSessionId: string
  subTurnId: string
  parentTurnId: string
  agentDir: string
  toolSchemas: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
}

interface SubAgentJobResult {
  finalText: string
  usage: { input: number; output: number }
  toolCallCount: number
  rounds: number
  finishReason: string
}

export async function handle(job: SubAgentJobInput, ctx: JobContext): Promise<SubAgentJobResult> {
  if (!ctx.chatComplete) {
    throw new Error('sub-agent worker requires chatComplete in JobContext')
  }

  const dispatchTool: ToolCallHandler = async (call) => {
    const response = await ctx.dispatchTool!(call)
    return response
  }

  return runMiniTurnLoop({
    descriptor: job.descriptor,
    userPrompt: job.userPrompt,
    subSessionId: job.subSessionId,
    subTurnId: job.subTurnId,
    parentTurnId: job.parentTurnId,
    chatComplete: ctx.chatComplete,
    dispatchTool,
    toolSchemas: job.toolSchemas,
    log: ctx.log ?? (() => {}),
  })
}

if (process.env.JOB_MODE === 'spawn' && process.env.JOB_WORKER_ENTRY === '1') {
  runWorker((job, ctx) => handle(job as SubAgentJobInput, ctx))
    .catch((err: unknown) => {
      process.stderr.write(`sub-agent worker failed: ${String(err)}\n`)
      process.exit(1)
    })
}
```

**Rationale for static import:** 动态 `import()` 在测试 env 下若有 `JOB_MODE` 泄露则异步加载 runtime 并劫持 stdin——buried failure。静态 import 在编译时验证路径存在,失败在文件保存时刻而非 spawn 时刻。`JOB_WORKER_ENTRY=1` 作为正向 opt-in 信号(由 spawner 设置),消除 leaked-env-var 失败模式。

### 4.2 Mini turn loop:`mini-turn-loop.ts`

> **Design decision (Q2):** Path A — 自定义 mini loop,不复用 `runTurnUsecase`。

#### 4.2.0 为什么不用 `runTurnUsecase`

`runTurnUsecase` 承担 10 个 sub-agent worker **不需要且必须禁掉** 的职责:

| `runTurnUsecase` 职责 | Sub-agent worker 需要? |
|---|---|
| `transformPrompt` hook dispatch | **No** — 正是隔离目标 |
| `resolveTools` hook dispatch | **No** — worker 从 descriptor 获取 `allowedToolNames` |
| Auto-compaction | **No** — sub-agent history 随进程消亡 |
| Reactive budget guard | **No** — 同上 |
| Trace event emission | **No** — parent 拥有 trace stream |
| `onTurnStart`/`onTurnEnd` hooks | **No** — 在 parent turn 内嵌套 |
| `sessionAbort` registry | **No** — abort 经 stdin EOF + `AbortController` 传播 |
| `appendHistory` to `SessionHistoryPort` | **No** — in-memory,返回 result |
| `ContractBus.emit('wave.completed')` | **No** — parent bus |
| Streaming via `runTurn` async iterator | **No** — `chatComplete` 单轮;loop 就是 streaming |

"复用" `runTurnUsecase` 意味着为 worker 构建 9 个 stub/adapter 以欺骗一个不相关的 usecase——代码量超过 150 行 mini loop,且将 worker 与 `RunTurnUsecaseDeps` 的每次变更耦合。

工具调用解析的**唯一共享点**:tool_use block 的解析原语。Mini loop 和 chat adapter 应从同一来源 import。

#### 4.2.1 Loop 实现

```ts
// src/extensions/sub-agent/mini-turn-loop.ts
import type { SubAgentDescriptor } from './types'
import type { ChatCompleteRequest, ChatCompleteResponse } from '../../application/ports/job-spawner'

export type ToolCallHandler = (call: {
  name: string
  arguments: Record<string, unknown>
  callId: string
}) => Promise<{ success: boolean; result?: unknown; error?: { code: string; message: string } }>

export type LlmFailureReason =
  | 'network'
  | 'rate_limit'
  | 'auth'
  | 'invalid_response'
  | 'unknown'

interface MiniLoopDeps {
  descriptor: SubAgentDescriptor
  userPrompt: string
  subSessionId: string     // for logging only
  subTurnId: string        // for logging only
  parentTurnId: string     // for logging only
  chatComplete: (req: ChatCompleteRequest) => Promise<ChatCompleteResponse>
  dispatchTool: ToolCallHandler
  toolSchemas: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  log: (level: 'info' | 'warn' | 'error', msg: string) => void
}

interface MiniLoopResult {
  finalText: string
  usage: { input: number; output: number }
  toolCallCount: number
  rounds: number
  finishReason: string
}

const DEFAULT_MAX_ROUNDS = 10
const MAX_TOOL_FAILURES_PER_NAME = 3  // Design decision (Q7): N=3 per unique tool

export async function runMiniTurnLoop(deps: MiniLoopDeps): Promise<MiniLoopResult> {
  const { descriptor: desc, chatComplete, dispatchTool, toolSchemas, log } = deps
  const maxRounds = desc.maxRounds ?? DEFAULT_MAX_ROUNDS
  const maxTotalTokens = desc.maxTotalTokens ?? Infinity

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: desc.systemPrompt },
    { role: 'user', content: deps.userPrompt },
  ]

  let totalUsage = { input: 0, output: 0 }
  let toolCallCount = 0
  let finalText = ''
  const toolFailureCounts = new Map<string, number>()

  for (let round = 0; round < maxRounds; round++) {
    // Budget 熔断
    if (totalUsage.input + totalUsage.output > maxTotalTokens) {
      log('warn', `sub-agent budget exhausted: ${totalUsage.input + totalUsage.output} > ${maxTotalTokens}`)
      return {
        finalText:
          `<sub-agent-error type="budget_exhausted" totalTokens="${totalUsage.input + totalUsage.output}" maxTokens="${maxTotalTokens}">` +
          `<partial-result>${escapeXml(finalText)}</partial-result></sub-agent-error>`,
        usage: totalUsage, toolCallCount, rounds: round + 1,
        finishReason: 'budget',
      }
    }

    let resp: ChatCompleteResponse
    try {
      resp = await chatComplete({
        purpose: `subagent.run.${desc.type}`,
        messages,
        tools: toolSchemas,
        maxTokens: desc.maxTokensPerCall,
      })
    } catch (err) {
      const reason = classifyLlmError(err)
      log('error', `chatComplete failed (${reason}): ${String(err)}`)
      return {
        finalText: `<sub-agent-error type="llm_failed" reason="${reason}"></sub-agent-error>`,
        usage: totalUsage, toolCallCount, rounds: round + 1,
        finishReason: 'error',
      }
    }

    totalUsage.input += resp.usage.input
    totalUsage.output += resp.usage.output

    // 无 toolCalls → terminal
    if (!resp.toolCalls || resp.toolCalls.length === 0) {
      finalText = resp.content

      switch (resp.finishReason) {
        case 'stop':
          return { finalText, usage: totalUsage, toolCallCount, rounds: round + 1, finishReason: 'stop' }
        case 'length':
          return {
            finalText: `<sub-agent-error type="response_truncated" reason="length"><partial-result>${escapeXml(finalText)}</partial-result></sub-agent-error>`,
            usage: totalUsage, toolCallCount, rounds: round + 1, finishReason: 'length',
          }
        case 'content_filter':
          return {
            finalText: `<sub-agent-error type="response_filtered" reason="content_filter"></sub-agent-error>`,
            usage: totalUsage, toolCallCount, rounds: round + 1, finishReason: 'content_filter',
          }
        default:
          // finishReason === 'stop' handled above; 'tool_calls' shouldn't reach here
          return { finalText, usage: totalUsage, toolCallCount, rounds: round + 1, finishReason: resp.finishReason }
      }
    }

    // 有 toolCalls → 执行
    messages.push({ role: 'assistant', content: resp.content })

    for (const tc of resp.toolCalls) {
      toolCallCount++
      const response = await dispatchTool({
        name: tc.name,
        arguments: tc.arguments,
        callId: tc.id,
      })

      if (!response.success) {
        const code = response.error?.code
        if (code === 'TOOL_NOT_ALLOWED' || code === 'TOOL_NOT_FOUND') {
          // Structural errors — bail immediately
          return {
            finalText: `<sub-agent-error type="tool_unavailable" toolName="${tc.name}" reason="${code}"></sub-agent-error>`,
            usage: totalUsage, toolCallCount, rounds: round + 1,
            finishReason: 'tool_unavailable',
          }
        }
        // TOOL_EXEC_FAIL — inject as tool result, track per-name failures
        const count = (toolFailureCounts.get(tc.name) ?? 0) + 1
        toolFailureCounts.set(tc.name, count)
        messages.push({
          role: 'tool',
          content: `<tool-error>${escapeXml(response.error!.message)}</tool-error>`,
        })
        if (count >= MAX_TOOL_FAILURES_PER_NAME) {
          return {
            finalText: `<sub-agent-error type="tool_failed" toolName="${tc.name}" attempts="${count}"><partial-result>${escapeXml(finalText)}</partial-result></sub-agent-error>`,
            usage: totalUsage, toolCallCount, rounds: round + 1,
            finishReason: 'tool_failed',
          }
        }
      } else {
        messages.push({
          role: 'tool',
          content: typeof response.result === 'string' ? response.result : JSON.stringify(response.result),
        })
      }
    }
  }

  // 超出 maxRounds
  log('warn', `sub-agent reached maxRounds=${maxRounds}, force-finalizing`)
  return {
    finalText:
      `<sub-agent-error type="max_rounds_reached" rounds="${maxRounds}" maxRounds="${maxRounds}">` +
      `<partial-result>${escapeXml(finalText)}</partial-result></sub-agent-error>`,
    usage: totalUsage, toolCallCount, rounds: maxRounds,
    finishReason: 'max_rounds',
  }
}

function classifyLlmError(err: unknown): LlmFailureReason {
  const msg = err instanceof Error ? err.message : String(err)
  if (/rate.limit|429|quota/i.test(msg)) return 'rate_limit'
  if (/unauthorized|401|403|auth/i.test(msg)) return 'auth'
  if (/network|timeout|ECONN|ETIMEDOUT/i.test(msg)) return 'network'
  if (/parse|invalid|unexpected/i.test(msg)) return 'invalid_response'
  return 'unknown'
}
```

### 4.3 Worker 端拿到工具 schema 的方式

> **Design:** init frame 携带所有 tool schemas。

**方案:** parent 在 spawn 时把 `desc.allowedToolNames` 对应的 tool 元数据序列化进 job payload。Worker 直接用于 `chatComplete` 的 `tools` 字段。Init frame 大小:单 tool schema ~500B,allowedToolNames 通常 ≤10 个,总计 < 5KB(远在 128KB 限制内)。

```ts
// runner-spawner.ts 内
toolSchemas: desc.allowedToolNames
  .filter(n => n !== 'task')  // 防递归
  .map(name => {
    const t = deps.toolCatalog.get(name)
    return t ? { name: t.name, description: t.description, parameters: t.parameters } : null
  })
  .filter(Boolean),
```

---

## 5. Parent 端实现

### 5.1 `runner-spawner.ts`

```ts
import type { SubAgentRunner, SubAgentRunInput, SubAgentDescriptor } from './types'
import type { JobSpawner, ChatCompleteRequest, ChatCompleteResponse } from '../../application/ports/job-spawner'
import type { ToolCatalogPort } from '../../application/ports/tool-catalog'
import type { Logger } from '../../application/ports/logger'
import type { ContractBus } from '../../application/event-bus/contract-bus'
import type { SubAgentRegistry } from './registry'

export interface SpawnerRunnerDeps {
  spawner: JobSpawner
  registry: SubAgentRegistry
  toolCatalog: ToolCatalogPort
  chatComplete: (req: ChatCompleteRequest) => Promise<ChatCompleteResponse>
  bus: ContractBus
  logger: Logger
  agentDir: string
}

const CONCURRENT_SEMAPHORE = new Map<string, number>() // turnId → active count
const MAX_CONCURRENT_SUBAGENTS_PER_TURN = 3

export function createSpawnerSubAgentRunner(deps: SpawnerRunnerDeps): SubAgentRunner {
  return async (input: SubAgentRunInput): Promise<string> => {
    const desc = deps.registry.get(input.type)
    if (!desc) {
      const available = deps.registry.list().map(d => d.type).join(', ')
      return `<sub-agent-error type="unknown_subagent_type" reason="${input.type}" available="${escapeXmlAttr(available)}" />`
    }

    // Concurrency cap (Q3)
    const current = (CONCURRENT_SEMAPHORE.get(input.parentTurnId) ?? 0)
    if (current >= MAX_CONCURRENT_SUBAGENTS_PER_TURN) {
      deps.logger.warn('sub-agent', `concurrency cap reached for turn ${input.parentTurnId}`)
      return `<sub-agent-error type="busy" reason="too many concurrent sub-agents (max ${MAX_CONCURRENT_SUBAGENTS_PER_TURN})" />`
    }
    CONCURRENT_SEMAPHORE.set(input.parentTurnId, current + 1)

    const subSessionId = `sub:${input.parentTurnId}:${generateULID()}`
    const subTurnId = `${input.parentTurnId}#sub-${input.parentCallId}`

    void deps.bus.emit('subagent.started', {
      parentTurnId: input.parentTurnId, parentSessionId: input.parentSessionId,
      type: input.type, subSessionId, callId: input.parentCallId, ts: Date.now(),
    })

    try {
      const result = await deps.spawner.run<SubAgentJobInput, SubAgentResult>({
        entry: require.resolve('./worker-entry-subagent'),
        job: {
          descriptor: desc,
          userPrompt: input.prompt,
          subSessionId,
          subTurnId,
          parentTurnId: input.parentTurnId,
          agentDir: deps.agentDir,
          toolSchemas: buildToolSchemas(deps.toolCatalog, desc),
        },
        ctx: createParentJobContext(deps, desc, input),
        timeoutMs: desc.lifetimeMs ?? 120_000,
      })

      void deps.bus.emit('subagent.completed', {
        parentTurnId: input.parentTurnId, type: input.type, subSessionId,
        callId: input.parentCallId, ok: true,
        usage: result.usage, finalText: result.finalText,
        finishReason: result.finishReason, ts: Date.now(),
      })
      return result.finalText
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const tag = (err instanceof Error && err.name === 'AbortError') ? 'cancelled' : 'failed'
      deps.logger.warn('sub-agent', `worker ${tag} [${input.type}]: ${msg}`)

      if (tag === 'failed') {
        const exitCode = (err as any)?.exitCode
        const stderrTail = (err as any)?.stderr
        void deps.bus.emit('subagent.completed', {
          parentTurnId: input.parentTurnId, type: input.type, subSessionId,
          callId: input.parentCallId, ok: false,
          error: { code: 'WORKER_CRASH', message: msg, exitCode, stderrTail },
          ts: Date.now(),
        })
      }
      return `<sub-agent-error type="${tag}" reason="${escapeXmlAttr(msg)}" />`
    } finally {
      const c = CONCURRENT_SEMAPHORE.get(input.parentTurnId) ?? 1
      if (c <= 1) {
        CONCURRENT_SEMAPHORE.delete(input.parentTurnId)
      } else {
        CONCURRENT_SEMAPHORE.set(input.parentTurnId, c - 1)
      }
    }
  }
}
```

### 5.2 Parent 端 `JobContext` 构建

```ts
function createParentJobContext(deps, desc, input): JobContext {
  return {
    invoke: async (req) => {
      if (!PURPOSE_WHITELIST.has(req.purpose)) {
        throw new Error(`purpose "${req.purpose}" not in whitelist`)
      }
      return await deps.providerInvoke.call({ ...req, parentTurnId: input.parentTurnId, signal: input.parentSignal })
    },
    chatComplete: async (req: ChatCompleteRequest) => {
      return await deps.chatComplete({ ...req, signal: input.parentSignal })
    },
    dispatchTool: async (call) => {
      // 工具白名单校验
      if (!desc.allowedToolNames.includes(call.name)) {
        return { success: false, error: { code: 'TOOL_NOT_ALLOWED' as const, message: `tool "${call.name}" not in allowedToolNames for sub-agent "${desc.type}"` } }
      }
      const tool = deps.toolCatalog.get(call.name)
      if (!tool) {
        return { success: false, error: { code: 'TOOL_NOT_FOUND' as const, message: `tool "${call.name}" not found in catalog` } }
      }
      try {
        const ctx: ToolContext = {
          signal: input.parentSignal,
          environment: { cwd: deps.agentDir },
          sink: createToolSink(),
          sessionId: input.parentSessionId,   // parent's — permissions inheritance
          turnId: input.parentTurnId,         // parent's — conflictKey 一致性
          callId: call.callId,
          source: {                           // Q6: trace attribution
            kind: 'subagent',
            subAgentType: input.type,
            subAgentCallId: input.parentCallId,
          },
        }
        const result = await tool.execute(ctx, tool.parse(call.arguments))
        return { success: true, result }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { success: false, error: { code: 'TOOL_EXEC_FAIL' as const, message: msg } }
      }
    },
    log: (level, msg) => deps.logger[level]('sub-agent.worker', msg),
  }
}
```

### 5.3 `BunSpawnJobSpawner` 处理新 frame kinds

```ts
case 'chat-req':
  await this.handleChatRequest(frame, child.stdin, opts.ctx, jobType, spawnId)
  break
case 'tool-call-req':
  await this.handleToolCall(frame, child.stdin, opts.ctx, jobType, spawnId)
  break
case 'progress':
  this.relayProgress(frame, jobType)
  break
```

`handleChatRequest`:

```ts
private async handleChatRequest(frame, stdin, ctx, jobType, spawnId): Promise<void> {
  const payload = frame.payload as ChatRequestPayload
  if (!CHAT_PURPOSE_WHITELIST.has(payload.purpose) &&
      !payload.purpose.startsWith('subagent.run.')) {
    void stdin.write(encodeFrame({ v: 1, id: frame.id, kind: 'chat-error', ts: Date.now(),
      payload: { code: 'PURPOSE_NOT_ALLOWED', message: `purpose "${payload.purpose}" not allowed` }}))
    return
  }
  if (!ctx.chatComplete) {
    void stdin.write(encodeFrame({ v: 1, id: frame.id, kind: 'chat-error', ts: Date.now(),
      payload: { code: 'PROVIDER_FAIL', message: 'chatComplete not configured for this worker' }}))
    return
  }
  try {
    const resp = await ctx.chatComplete(payload)
    void stdin.write(encodeFrame({ v: 1, id: frame.id, kind: 'chat-resp', ts: Date.now(), payload: resp }))
  } catch (err) {
    void stdin.write(encodeFrame({ v: 1, id: frame.id, kind: 'chat-error', ts: Date.now(),
      payload: { code: 'PROVIDER_FAIL', message: err instanceof Error ? err.message : String(err) }}))
  }
}
```

`handleToolCall`:

```ts
private async handleToolCall(frame, stdin, ctx, jobType, spawnId): Promise<void> {
  const payload = frame.payload as ToolCallRequestPayload
  if (!ctx.dispatchTool) {
    void stdin.write(encodeFrame({ v: 1, id: frame.id, kind: 'tool-call-resp', ts: Date.now(),
      payload: { success: false, error: { code: 'TOOL_NOT_ALLOWED', message: 'tool dispatch not enabled for this worker' }}}))
    return
  }
  const result = await ctx.dispatchTool(payload)
  void stdin.write(encodeFrame({ v: 1, id: frame.id, kind: 'tool-call-resp', ts: Date.now(), payload: result }))
}
```

### 5.4 Worker runtime 适配:`spawn-worker-runtime.ts`

```diff
+const pendingChat = new Map<string, { resolve, reject }>()

+// In frame loop:
+case 'chat-resp':
+  { const p = pendingChat.get(frame.id); if (p) { pendingChat.delete(frame.id); p.resolve(frame.payload); } }
+  break
+case 'chat-error':
+  { const p = pendingChat.get(frame.id); if (p) { pendingChat.delete(frame.id); p.reject(new Error(frame.payload?.message ?? 'LLM call failed')); } }
+  break

+// In WorkerContext:
+chatComplete: async (req) => {
+  const id = generateULID()
+  const frame = { v: 1, id, kind: 'chat-req', ts: Date.now(), payload: req }
+  return new Promise((resolve, reject) => {
+    pendingChat.set(id, { resolve, reject })
+    writeFrame(frame)
+    setTimeout(() => { if (pendingChat.has(id)) { pendingChat.delete(id); reject(new Error('chatComplete timeout')); } }, 70_000)
+  })
+}
```

---

## 6. 错误分类

> **Design decision (Q7):** 两层错误体系 — parent-internal codes(monitoring) + LLM-facing XML blocks(recovery)。

### 6.1 Surface 1: Parent-internal 错误代码(spawner logs, trace, alerting)

| Code | When | Retryable |
|---|---|---|
| `TOOL_NOT_ALLOWED` | Tool not in allowedToolNames | No |
| `TOOL_NOT_FOUND` | Tool not in parent catalog | No |
| `TOOL_EXEC_FAIL` | Tool execution threw | Maybe (tool-specific) |
| `WORKER_SPAWN_FAIL` | bun:spawn failed | Yes |
| `WORKER_CRASH` | Non-zero exit, stderr captured | No |
| `WORKER_TIMEOUT` | Total time exceeded | Yes (with backoff) |
| `WORKER_NO_RESULT` | Exit 0, no result frame | No |
| `CHAT_PURPOSE_DENIED` | Purpose not in CHAT_PURPOSE_WHITELIST | No |
| `FRAME_MALFORMED` | Invalid JSON from worker stdout | No |
| `FRAME_OVERSIZED` | Frame > 128KB cap | No |

### 6.2 Surface 2: LLM-facing `<sub-agent-error type="...">` codes

| Type | When | Attributes |
|---|---|---|
| `unknown_subagent_type` | Bad `subagent_type` arg | `reason`, `available` |
| `busy` | Concurrency cap hit | `reason` |
| `failed` | Worker crashed | `reason` (sanitized) |
| `cancelled` | Timeout or parent abort | `reason` |
| `no_result` | Worker exited clean without producing result | — |
| `llm_failed` | `chatComplete` threw | `reason` (sanitized enum: `network`/`rate_limit`/`auth`/`invalid_response`/`unknown`) |
| `max_rounds_reached` | Hit maxRounds | `rounds`, `maxRounds`, `<partial-result>` |
| `budget_exhausted` | Hit maxTotalTokens | `totalTokens`, `maxTokens`, `<partial-result>` |
| `empty_response` | LLM returned nothing, finishReason=stop | — |
| `response_truncated` | finishReason=length | `<partial-result>` |
| `response_filtered` | finishReason=content_filter | — |
| `tool_unavailable` | TOOL_NOT_ALLOWED or TOOL_NOT_FOUND | `toolName`, `reason` |
| `tool_failed` | ≥3 TOOL_EXEC_FAIL for same tool name | `toolName`, `attempts`, `<partial-result>` |

### 6.3 Design rules

**Rule 1 (finishReason provenance):** 每个 terminal state 必须携带 `finishReason`——无论成功与否,记录 loop 为何停止(`stop`, `length`, `tool_calls`, `content_filter`, `max_rounds`, `budget`, `error`, `tool_unavailable`, `tool_failed`)。方便 trace 和 LLM recovery。

**Rule 2 (sanitization):** 所有经 `<sub-agent-error>` 返回给 parent LLM 的内容必须过 sanitization 层。Provider URLs、auth headers、raw stack traces、internal IDs 不得出现在 LLM-visible result 中。完整未 sanitized error 输出到 worker stderr(由 spawner 捕获,供 ops 查看)。

---

## 7. 集成:替换 `sub-agent/index.ts`

```diff
 export default () =>
   defineExtension({
     name: 'sub-agent',
     enforce: 'normal',
-    dependsOn: ['tool-catalog', 'session'],
+    dependsOn: ['tool-catalog', 'session', 'provider', 'infra-services'],

     apply(ctx) {
       const bus = asContractBus(ctx.bus)
       const registry = new SubAgentRegistry()
       registerBuiltins(registry)

+      const spawner = ctx.extensions.get('infra-services.job-spawner') as JobSpawner
+      const toolCatalog = ctx.extensions.get('tool-catalog.catalog') as ToolCatalogPort
+      const provider = ctx.extensions.get('provider.llm') as ProviderChat & ProviderInvoke
+
+      const runSubAgent = createSpawnerSubAgentRunner({
+        spawner, registry, toolCatalog, bus,
+        chatComplete: (req) => provider.complete({
+          messages: req.messages,
+          tools: req.tools,
+          maxTokens: req.maxTokens,
+          signal: req.signal,
+        }),
+        logger: ctx.logger, agentDir: ctx.agentDir,
+      })

-      const catalog = ctx.extensions.get('tool-catalog.catalog')
-      catalog.register(createTaskTool({ runSubAgent }))
+      const catalog = ctx.extensions.get('tool-catalog.catalog')
+      // M1 bug fix: enum 从 registry 动态生成
+      catalog.register(createTaskTool({ runSubAgent, registry }))

       return {
         provide: { 'sub-agent.registry': () => registry },
         dispose: () => registry.clear(),
       }
     },
   })
```

### 7.1 `task-tool.ts` 改造

```diff
-export function createTaskTool(deps: { runSubAgent: SubAgentRunner }): Tool {
+export function createTaskTool(deps: { runSubAgent: SubAgentRunner; registry: SubAgentRegistry }): Tool {
   return {
     name: 'task',
     description: 'Delegate a self-contained sub-task to a sub-agent...',
     parameters: {
       type: 'object',
       properties: {
         subagent_type: {
           type: 'string',
-          enum: ['explore', 'plan', 'general-purpose'],
+          enum: deps.registry.list().map(d => d.type),  // M1 bug fix: dynamic
         },
         description: { type: 'string' },
         prompt: { type: 'string' },
       },
       required: ['subagent_type', 'description', 'prompt'],
     },
     readonly: false,
     renderHint: 'widget',
     parse(raw) { /* ... */ },
     execute(ctx, params) { return deps.runSubAgent({ type: params.subagent_type, ... }) },
-    conflictKey: (_toolCtx, input: unknown) => {
-      const type = (input as { subagent_type?: string })?.subagent_type ?? 'unknown'
-      return `subagent:${type}`
-    },
+    // Q3: conflictKey 已移除 — 并发控制由 runner-spawner 的 semaphore 处理
   }
 }
```

---

## 8. 并发控制

> **Design decision (Q3):** 移除 `conflictKey`,替换为 per-turn semaphore cap。

- **Cap**: `MAX_CONCURRENT_SUBAGENTS_PER_TURN = 3`
- **Enforcement point**: `createSpawnerSubAgentRunner` 入口处 per-turn counter
- **Over-cap behavior**: 返回 `<sub-agent-error type="busy">`,不排队
- **Rationale**: 每个 sub-agent 是独立 OS 进程,无共享 turn state。Cap 防止 LLM 发射 20 个 task 导致的 runaway fan-out。后续可观测后调大。

---

## 9. 安全边界

### 9.1 LLM purpose 白名单

`CHAT_PURPOSE_WHITELIST` 使用前缀匹配 `"subagent.run."`:

```ts
const allowedChatPrefixes = ['subagent.run.']
// extension 注册新 sub-agent type 自动通过
```

### 9.2 Tool 白名单

`desc.allowedToolNames` 在 parent `dispatchTool` 入口处校验(§5.2)。Worker 不可信。

### 9.3 权限继承

> **Design decision (Q6):** 子 agent 继承 parent 权限,不可权限提升。

ToolContext 使用 parent 的 `sessionId`/`turnId`,所以 `permission.checker` 的 `onToolCall` hook 适用 parent-level permission rules。Sub-agent 不能在 permission 层面做 parent 不能做的事。

**明确记录:这是设计意图。** Sub-agent 没有独立的 permission grants;parent 委托任务,parent 对调用的 tool 负责。

### 9.4 资源上限

```diff
 interface SubAgentDescriptor {
   type: string
   description: string
   systemPrompt: string
   allowedToolNames: readonly string[]
   maxRounds?: number
-  maxOutputTokens?: number
+  maxTokensPerCall?: number       // 重命名澄清语义(per-call max_tokens)
+  maxTotalTokens?: number          // 跨轮 budget 上限,熔断保护
+  lifetimeMs?: number              // 整体超时(默认 120s)
   modelHint?: 'fast' | 'strong'
   source: 'builtin' | 'extension'
 }
```

---

## 10. Trace 归因

> **Design decision (Q6):** Hybrid C — parent identity + `source` metadata field。

```ts
// ToolContext.source for sub-agent tool calls
source: {
  kind: 'subagent'
  subAgentType: string       // 'explore' | 'plan' | 'general-purpose'
  subAgentCallId: string     // the task() call that spawned this worker
}
```

- **Permission checker**: 读 `sessionId`/`turnId`(parent identity),忽略 `source`
- **Trace consumer**: 读 `source.subAgentCallId` 区分 parent-originated vs sub-agent-originated tool calls
- **并发 sub-agent**: 每笔 tool.call 自带 `source`,无 ambiguity
- **`callId`**: 保持 opaque,不承载结构化归因信息

---

## 11. 测试方案

### 11.1 单元测试

| File | Coverage |
|---|---|
| `tests/unit/sub-agent/mini-turn-loop.test.ts` | maxRounds;maxTotalTokens 熔断;tool error → inject → N=3 bail;llm_failed 分类;finishReason 分支(stop/length/content_filter);empty_response |
| `tests/unit/sub-agent/runner-spawner.test.ts` | turnId 不冲突(并行 3 个 task);unknown_subagent_type;concurrency cap;WORKER_CRASH → `<sub-agent-error type="failed">`;WORKER_TIMEOUT → `<sub-agent-error type="cancelled">` |
| `tests/unit/jobs/spawn-rpc-frame.test.ts` | chat-req/chat-resp encode/decode;tool-call-req/tool-call-resp encode/decode;chunked-input fuzz(partial reads at arbitrary byte boundaries);FrameDecoder robustness |
| `tests/unit/jobs/spawn-rpc-whitelist.test.ts` | TOOL_NOT_ALLOWED 拦截;TOOL_NOT_FOUND 映射;CHAT_PURPOSE_WHITELIST 校验 |

### 11.2 Integration smoke(real spawn)

| File | Scenarios |
|---|---|
| `tests/integration/sub-agent-spawn-smoke.test.ts` | Scenario A: spawn → 1 chatComplete → 1 tool call → 1 chatComplete → result(~250ms)。Scenario B: spawn → in-flight chatComplete → shutdown → graceful exit(~250ms) |

- 位于 `tests/integration/`(新目录),与 e2e 分离
- 使用真实 `bun:spawn`,真实 worker entry path,真实 NDJSON pipe
- Per-test timeout 5s,captures worker stderr
- 在 main CI job,非 nightly

### 11.3 E2E(behavior, fake spawner)

| File | Scenarios |
|---|---|
| `tests/e2e/sub-agent-flow.spec.ts` | F18.1–F18.4(4 scenarios) + error propagation + parallel + abort cascade + multi-turn parent flows |

- 使用 `FakeSubAgentSpawner`(in-memory 替身,同步跑 mini-turn-loop)
- CI 时间预算 < 100ms / scenario

---

## 12. 文件清单

### 新增

| File | Lines | Purpose |
|---|---|---|
| `src/extensions/sub-agent/runner-spawner.ts` | ~180 | Parent 端 SubAgentRunner impl + semaphore |
| `src/extensions/sub-agent/worker-entry-subagent.ts` | ~60 | Worker entry(static import + JOB_WORKER_ENTRY guard) |
| `src/extensions/sub-agent/mini-turn-loop.ts` | ~200 | Worker 内多轮 tool loop + error taxonomy |
| `src/extensions/sub-agent/errors.ts` | ~20 | `ToolNotAllowedError`, `ToolNotFoundError` |
| `tests/unit/sub-agent/mini-turn-loop.test.ts` | ~150 | Unit tests |
| `tests/unit/sub-agent/runner-spawner.test.ts` | ~120 | Unit tests |
| `tests/unit/jobs/spawn-rpc-frame.test.ts` | ~120 | Frame protocol + fuzz |
| `tests/integration/sub-agent-spawn-smoke.test.ts` | ~150 | Real spawn smoke tests |
| `tests/e2e/_fixtures/fake-sub-agent-spawner.ts` | ~100 | E2E fixture |

### 修改

| File | Changes |
|---|---|
| `src/infrastructure/jobs/spawn-rpc/frame.ts` | +6 FrameKind + 6 payload types |
| `src/infrastructure/jobs/bun-spawn-job-spawner.ts` | +`handleChatRequest` + `handleToolCall` + `relayProgress`; +`CHAT_PURPOSE_WHITELIST`; +`JOB_WORKER_ENTRY=1` in env |
| `src/infrastructure/jobs/spawn-worker-runtime.ts` | +`chatComplete` IPC client; +`pendingChat` map |
| `src/application/ports/job-spawner.ts` | +`ChatCompleteRequest`/`ChatCompleteResponse` types; +`chatComplete` + `dispatchTool` on `JobContext` |
| `src/application/ports/tool-context.ts` | +`source?: ToolCallSource` sealed union |
| `src/extensions/sub-agent/index.ts` | Replace with spawner-based runner |
| `src/extensions/sub-agent/task-tool.ts` | Dynamic enum from registry; remove conflictKey |
| `src/extensions/sub-agent/types.ts` | +`maxTokensPerCall`/`maxTotalTokens`/`lifetimeMs`; rename `maxOutputTokens` |
| `src/extensions/sub-agent/registry.ts` | Builtin descriptor field rename |

### 删除

无(M1 代码全部演进,不删除).

---

## 13. Follow-ups

- **Cross-process tool safety**: `conflictKey` 仅在同进程内 wave 保护。跨进程 mutating tools(WriteFile 等)需要独立锁定机制。Not M2 blocker(M2 sub-agent 读多于写)。
- **Backport worker-entry hardening**: 将 static import + `JOB_WORKER_ENTRY` guard 应用到 `hello-worker.ts` 和 `evolution/worker-entry.ts`。
- **Worker pool 预热**: 减少 100–300ms 冷启动延迟。
- **Stream-over-IPC**: M2 用 `chatComplete`(非流式),大输出依赖 `progress` frame。真流式留 M3。

---

## 14. 验收标准

- [ ] sub-agent systemPrompt 不出现在 parent provider.receivedRequests 中(隔离验证)
- [ ] parent identity 切换不影响正在跑的 sub-agent
- [ ] 并发 3 个 task 调用:每个 sub-agent 独立 OS 进程,turnId 无冲突,trace 无串扰(M2 实现真 OS 级并发)
- [ ] `trace.tool.call` events 通过 `source.subAgentCallId` 归因到具体 `task()` 调用
- [ ] `desc.maxRounds: 3` 真正生效:sub-agent 最多 3 轮 LLM call,返回 `<sub-agent-error type="max_rounds_reached">`
- [ ] `desc.maxTotalTokens: 5000` 熔断:超出后中断,返回 `<sub-agent-error type="budget_exhausted">` 含 partial result
- [ ] `desc.maxTokensPerCall` 重命名:per-call max_tokens 语义清晰
- [ ] `subagent_type.enum` 从 registry 动态生成:extension 注册新 type 后 LLM schema 自动更新
- [ ] Tool 白名单:未在 allowedToolNames 中的 tool → `TOOL_NOT_ALLOWED`
- [ ] 防递归:`task` tool 自动从 allowedToolNames 过滤
- [ ] Worker crash → `<sub-agent-error type="failed">`
- [ ] Worker timeout → `<sub-agent-error type="cancelled">`
- [ ] Parent abort 信号传播到 worker chatComplete(经 AbortSignal cascade)
- [ ] `chatComplete` failure → 分类为 `llm_failed` 且 sanitized(不泄露 API key/URL/stack trace)
- [ ] `finishReason='length'` → `<sub-agent-error type="response_truncated">`
- [ ] `finishReason='content_filter'` → `<sub-agent-error type="response_filtered">`
- [ ] Tool 连续 3 次 TOOL_EXEC_FAIL(同 tool name) → `<sub-agent-error type="tool_failed">` bail
- [ ] TOOL_NOT_ALLOWED / TOOL_NOT_FOUND → `<sub-agent-error type="tool_unavailable">` bail
- [ ] Concurrency cap per turn:3 个后返回 `<sub-agent-error type="busy">`
- [ ] `lifetimeMs` 超时 → shutdown frame → SIGKILL after 5s grace
- [ ] CI:`bun test` 全量 < 10s(增加 5 unit + 2 integration + 4 e2e 后)
