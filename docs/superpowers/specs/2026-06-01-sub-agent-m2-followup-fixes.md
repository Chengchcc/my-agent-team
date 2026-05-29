# Spec: Sub-Agent M2 Follow-Up Fixes

> **Status**: Ready (grilled — 8 design decisions resolved)
> **Predecessor**: [`2026-05-29-sub-agent-process-isolation.md`](./2026-05-29-sub-agent-process-isolation.md) (M2 design)
> **Scope**: Fix 4 P0 + 4 P1 + 2 P2 bugs surfaced by post-merge audit of `f9adf79`.
> **Goal**: Make real `Bun.spawn` sub-agent path actually work end-to-end, restore spec contract compliance, and close observability gaps.

---

## 0. Design Decisions from Grill (Q1–Q8)

| Q | Topic | Decision |
|---|---|---|
| Q1 | P0-4 `finishReason` field | **A**: mandatory on `ChatResponse`, no new type |
| Q2 | P0-3 bus.emit exception strategy | **Swallow + `startEmitted` pairing guard**, counter always released in `finally` |
| Q3 | P0-1 tool-call-resp vs error frame boundary | **business failure → `tool-call-resp { success: false }`; infra failure → `error` frame; `state.fatal` mechanism; `pendingTool` NOT in error branch** |
| Q4 | WorkerRpcError scope | **All IPC errors unified**, `classifyLlmError` only in mini-loop, delete all regex-on-message |
| Q5 | P0-4 + P1-1 batch | **Same batch, `ChatRequest.purpose` mandatory** (same logic as `finishReason`) |
| Q6 | Integration smoke test design | **4-layer assertions + negative test (P0-1 regression lock) + Promise gate for timing + afterEach immediate shutdown** |
| Q7 | P1-4 static import risk | **Safe**, add `@worker-runtime` doc block + import-side-effect-free unit test |
| Q8 | Implementation order | **P0-4a first (highest blast radius)**, WorkerRpcError extracted as Step 0, P0-4 split a/b, 10 steps + 4 PRs |

---

## 1. Bug Inventory

| ID | Severity | Area | One-line |
|---|---|---|---|
| P0-1 | blocker | `spawn-worker-runtime.ts` | Missing `dispatchTool` IPC client in `createWorkerContext` |
| P0-2 | blocker | `task-tool.ts` | `enum` snapshots registry at wire time, ignores extension-registered types |
| P0-3 | blocker | `runner-spawner.ts` | `concurrentByTurn` is module-level global; can leak across instances |
| P0-4 | blocker | `spawn-chat-handlers.ts` + `sub-agent/index.ts` + `provider.ts` | `ChatResponse` lacks `finishReason`; bridges synthesize it, erasing real value |
| P1-1 | high | `spawn-chat-handlers.ts` | `handleChatRequest` has no timeout, no AbortSignal |
| P1-2 | high | `spawn-worker-runtime.ts` + `mini-turn-loop.ts` | All IPC errors are plain `Error`, `classifyLlmError` uses regex on message |
| P1-3 | high | `runner-spawner.ts` | No `subagent.completed { ok: false }` event on error path |
| P1-4 | high | existing workers | `JOB_WORKER_ENTRY` guard not backported; evolution/memory workers use dynamic import |
| P2-2 | low | `runner-spawner.ts` + `mini-turn-loop.ts` | `escapeXml` / `escapeXmlAttr` don't escape `\n` / `\r` / `\t` |
| P2-3 | low | `mini-turn-loop.ts` | `tool_calls` finishReason branch is dead code with bad fallback |

**Deferred to separate PR:** P2-1 (message format).

---

## 2. P0-1: Worker `dispatchTool` IPC Client

### 2.1 Problem

`createWorkerContext` returns `{ invoke, chatComplete, log }` — no `dispatchTool`. Worker entry throws on startup. Fake spawner bypasses this entirely.

### 2.2 Fix

Add `pendingTool` map, `dispatchTool` method on ctx, `tool-call-resp` frame handler. Plus `state.fatal` mechanism from Q3.

**File**: `src/infrastructure/jobs/spawn-worker-runtime.ts`

```ts
const WORKER_TOOL_TIMEOUT_MS = 60_000

interface WorkerState {
  pending: Map<string, PendingEntry>
  pendingChat: Map<string, PendingEntry>
  pendingTool: Map<string, PendingEntry>
  initialised: boolean
  exited: boolean
  fatal: WorkerRpcError | null            // Q3: fatal state
  writeFrame: (f: Frame) => void
}

// In createWorkerContext, add:
dispatchTool: (call) => {
  if (state.fatal) throw state.fatal       // Q3: fatal guard
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const timer = setTimeout(() => {
      state.pendingTool.delete(id)
      reject(new WorkerRpcError('TOOL_TIMEOUT', 'worker dispatchTool timeout', id))
    }, WORKER_TOOL_TIMEOUT_MS)
    state.pendingTool.set(id, { resolve, reject, timer })
    state.writeFrame({ v: 1, id, kind: 'tool-call-req', ts: Date.now(), payload: call })
  })
},

// In cancelAllPending: iterate state.pendingTool too.

// In makeHandleData, add:
case 'tool-call-resp':
  resolvePending(state.pendingTool, frame)
  break

// In error handler (Q3): reject ALL pendingTool, set state.fatal
case 'error': {
  const err = new WorkerRpcError(
    (frame.payload as { code?: string })?.code ?? 'UNKNOWN',
    (frame.payload as { message?: string })?.message ?? 'no message',
    frame.id,
  )
  // 1. Reject the triggering pending entry
  const entry = state.pending.get(frame.id) ?? state.pendingChat.get(frame.id)
  if (entry) { clearTimeout(entry.timer); entry.reject(err) }
  state.pending.delete(frame.id); state.pendingChat.delete(frame.id)
  // 2. Reject ALL pending tool calls (they'll never get a resp)
  for (const [id, tool] of state.pendingTool) {
    clearTimeout(tool.timer)
    tool.reject(new WorkerRpcError('WORKER_FATAL', `Worker entered fatal state: ${err.message}`, id))
  }
  state.pendingTool.clear()
  // 3. Mark fatal
  state.fatal = err
  break
}
```

### 2.3 Error semantics

| Scenario | Response | Worker handling |
|---|---|---|
| Tool not in allowedToolNames | `tool-call-resp { success: false, error: { code: 'TOOL_NOT_ALLOWED' } }` | mini-loop injects as tool result, LLM can retry |
| Tool execution throws | `tool-call-resp { success: false, error: { code: 'TOOL_EXEC_FAIL' } }` | injected as tool result |
| Tool timeout (parent side) | `tool-call-resp { success: false, error: { code: 'TOOL_TIMEOUT' } }` | injected as tool result |
| **Parent crash / protocol error / unrecoverable** | `error` frame | worker rejects ALL pending, sets `state.fatal`, enters shutdown |

**Tool error &ne; worker fatal.** Two distinct paths, no mixing.

### 2.4 Mini-loop two-path handling

```ts
try {
  const resp = await ctx.dispatchTool!(call)
  if (!resp.success) {
    // Business failure → feed back to LLM
    messages.push({ role: 'tool', content: `<tool-error>${resp.error!.message}</tool-error>` })
    continue
  }
  messages.push({ role: 'tool', content: resp.result })
} catch (err) {
  // Communication failure / worker fatal → unrecoverable
  if (err instanceof WorkerRpcError) throw err
  throw err
}
```

### 2.5 Acceptance

- Integration smoke test (§9) spawns real worker, worker calls `ctx.dispatchTool`, parent returns result, mini-loop continues
- Negative test: patch `createWorkerContext` to not expose `dispatchTool` → runner returns `<sub-agent-error>`
- `grep "pendingTool.*error" src/infrastructure/jobs/spawn-worker-runtime.ts` → 0 hits
- `grep "state\.fatal" src/infrastructure/jobs/spawn-worker-runtime.ts` → >=3 hits

---

## 3. P0-2: Dynamic Task Enum via Getter

### 3.1 Problem

`task-tool.ts:12` computes `enum: deps.registry.list().map(d => d.type)` once at wire time. Extension-registered sub-agent types invisible to LLM.

### 3.2 Fix

Replace `const schema = { ... }` with `get parameters()` getter. `resolveTools` hook reads `t.parameters` on every turn, so getter fires fresh each time.

```ts
return {
  name: 'task',
  get parameters(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        subagent_type: {
          type: 'string',
          enum: deps.registry.list().map(d => d.type),
          description: 'Type of sub-agent to invoke.',
        },
        description: { type: 'string', description: '...' },
        prompt: { type: 'string', description: '...' },
      },
      required: ['subagent_type', 'description', 'prompt'],
    }
  },
  // parse / execute unchanged
}
```

### 3.3 Acceptance

- Unit test: create task tool with explore only → read enum → register custom type → read enum again → includes custom

---

## 4. P0-3 + P1-3: Per-Instance Counter + Event Pairing

### 4.1 Problem

`concurrentByTurn` is module-level (`runner-spawner.ts:23`). Cross-test leak. Plus `bus.emit` failure can cause counter leak or trace gaps.

### 4.2 Fix (Q2: strategy c — swallow + pairing guard)

```ts
export function createSpawnerSubAgentRunner(deps: SpawnerRunnerDeps): SubAgentRunner {
  // Per-instance counter (was module-level)
  const concurrentByTurn = new Map<string, number>()

  function tryAcquire(turnId: string): boolean {
    const count = concurrentByTurn.get(turnId) ?? 0
    if (count >= MAX_CONCURRENT_SUBAGENTS_PER_TURN) return false
    concurrentByTurn.set(turnId, count + 1)
    return true
  }

  function release(turnId: string): void {
    const c = concurrentByTurn.get(turnId) ?? 1
    if (c <= 1) concurrentByTurn.delete(turnId)
    else concurrentByTurn.set(turnId, c - 1)
  }

  return async (input: SubAgentRunInput): Promise<string> => {
    const desc = deps.registry.get(input.type)
    if (!desc) { /* ... */ }

    if (!tryAcquire(input.parentTurnId)) { /* busy */ }

    let startEmitted = false
    try {
      // Q2: emit with pairing guard
      try {
        void deps.bus.emit('subagent.started', { ... })
        startEmitted = true
      } catch (err) {
        deps.logger.warn('sub-agent', `subagent.started emit failed: ${String(err)}`)
      }

      const result = await deps.spawner.run({ ... })

      if (startEmitted) {
        try { void deps.bus.emit('subagent.completed', { ok: true, ... }) } catch {}
      }
      return typed.finalText
    } catch (err) {
      if (startEmitted) {
        // P1-3: emit failure bookmark
        try {
          void deps.bus.emit('subagent.completed', { ok: false, finishReason: tag, ... })
        } catch {}
      }
      return errorResult(...)
    } finally {
      release(input.parentTurnId)
    }
  }
}
```

### 4.3 Acceptance

- `grep -rn "concurrentByTurn" src/` → only inside `createSpawnerSubAgentRunner` closure
- Two runner instances share no counter state
- `bus.emit('subagent.started')` throws → no completed emitted, counter released, sub-agent still returns result
- `subagent.completed { ok: false }` in trace on error path

---

## 5. P0-4: Provider-Chat finishReason + purpose

### 5.1 Problem

`ChatResponse` has no `finishReason`. Two bridges synthesize it via `hasToolCalls ? 'tool_calls' : 'stop'`, erasing `length`/`content_filter`. Mini-loop dead branches.

`ChatRequest` has no `purpose`. No audit trail, whitelist can't validate.

### 5.2 Fix (Q1: A — mandatory both fields)

**Step a — type + adapter (additive, backward-compatible):**

```ts
// src/application/ports/provider.ts
interface ChatRequest {
  purpose: string                    // mandatory — Q5
  messages: Array<{ role: string; content: string }>
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal               // optional (semantic difference)
  model?: string
}

interface ChatResponse {
  id: string
  content: string
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter'  // mandatory — Q1
  usage: { input: number; output: number }
  model: string
}
```

Adapter mappings:
- **Claude**: `stop_reason` → `end_turn`→`stop`, `max_tokens`→`length`, `tool_use`→`tool_calls`
- **OpenAI**: `finish_reason` → direct passthrough
- **E2EFakeProvider**: accept in preset, default `'stop'`
- **FakeProvider**: default `'stop'`

**Step b — delete synthesis (breaking, after step a merged):**

Remove `hasToolCalls ? 'tool_calls' : 'stop'` from:
- `spawn-chat-handlers.ts:51-60`
- `sub-agent/index.ts:38-52`

Replace with `finishReason: resp.finishReason`.

### 5.3 All callers scan

Every `provider.complete(...)` call site must pass `purpose`. Scan: `rg "\.complete\(\{[^}]*messages" src/` → ~4 sites, fix in same PR.

### 5.4 Acceptance

- `grep "hasToolCalls ? 'tool_calls' : 'stop'" src/` → 0 hits
- `grep "finishReason\?:" src/application/ports/` → 0 hits (not optional)
- `grep "purpose\?:" src/application/ports/` → 0 hits (not optional)
- All 4 `finishReason` values pass through to mini-loop (unit test)

---

## 6. P1-1: chat-req Timeout + AbortController

### 6.1 Problem

`handleChatRequest` has no timeout, no AbortSignal, didn't forward purpose to provider. Compare `handleInvokeReq` which has all three.

### 6.2 Fix

```ts
// spawn-chat-handlers.ts
export async function handleChatRequest(
  frame: Frame,
  stdin: ...,
  jobType: string,
  _spawnId: string,
  chatComplete: ProviderChat['complete'],
  logger: Logger,
  chatTimeoutMs: number,              // threaded from cfg
): Promise<void> {
  // ... whitelist + size checks (unchanged) ...

  const startTime = Date.now()
  const abortController = new AbortController()
  const timer = setTimeout(() => {
    abortController.abort()
    void stdin.write(encodeFrame({
      v: 1, id: frame.id, kind: 'chat-error', ts: Date.now(),
      payload: { code: 'TIMEOUT', message: `chat timeout after ${chatTimeoutMs}ms` },
    }))
  }, chatTimeoutMs)

  try {
    const resp = await chatComplete({
      purpose: frame.payload.purpose,          // was missing
      messages: payload.messages ?? [],
      tools: payload.tools ?? [],
      maxTokens: payload.maxTokens,
      signal: abortController.signal,          // was missing
    })
    clearTimeout(timer)
    // ... write chat-resp with resp.finishReason (P0-4b) ...
  } catch (err) {
    clearTimeout(timer)
    // ... write chat-error ...
  }
}
```

`bun-spawn-job-spawner.ts` threads `cfg.invokeTimeoutMs`:

```ts
private async handleChatRequest(...) {
  return handleChatRequest(frame, stdin, jobType, spawnId, this.chatComplete, this.logger, this.cfg.invokeTimeoutMs)
}
```

### 6.3 Acceptance

- Stub `chatComplete` to never resolve → `chat-error { code: 'TIMEOUT' }` after configured ms
- Integration smoke test verifies `purpose=subagent.run.<type>` appears in parent log

---

## 7. P1-2: WorkerRpcError — Unified IPC Error Type

### 7.1 Problem

All IPC errors are `new Error(...)`. `classifyLlmError` parses message strings with regex. Structured error codes (`PURPOSE_NOT_ALLOWED`, `RATE_LIMITED`) are lost.

### 7.2 Fix (Q4: all IPC errors unified)

**New file**: `src/infrastructure/jobs/spawn-rpc/errors.ts`

```ts
export type WorkerRpcCode =
  | 'TIMEOUT' | 'RATE_LIMITED' | 'PURPOSE_NOT_ALLOWED' | 'PROVIDER_ERROR'
  | 'TOOL_NOT_ALLOWED' | 'TOOL_EXEC_FAIL' | 'TOOL_TIMEOUT'
  | 'WORKER_FATAL' | 'PROTOCOL_VIOLATION' | 'WORKER_CRASHED'
  | 'UNKNOWN'

export class WorkerRpcError extends Error {
  public readonly name = 'WorkerRpcError'
  constructor(
    public readonly code: WorkerRpcCode,
    message: string,
    public readonly frameId?: string,
  ) {
    super(message)
  }
}
```

**Unified `rejectPending`:**

```ts
function rejectPending(
  state: WorkerState,
  mapKey: 'pending' | 'pendingChat' | 'pendingTool',
  frameId: string,
  code: WorkerRpcCode,
  message: string,
): void {
  const map = state[mapKey]
  const entry = map.get(frameId)
  if (entry) { clearTimeout(entry.timer); map.delete(frameId); entry.reject(new WorkerRpcError(code, message, frameId)) }
}
```

**`classifyLlmError` rewritten (mini-loop only):**

```ts
function classifyLlmError(err: unknown): LlmFailureReason {
  if (err instanceof WorkerRpcError) {
    switch (err.code) {
      case 'RATE_LIMITED': return 'rate_limit'
      case 'TIMEOUT': return 'network'
      case 'PURPOSE_NOT_ALLOWED': return 'auth'
      case 'WORKER_FATAL': case 'PROTOCOL_VIOLATION': return 'unknown'
      default: return 'unknown'
    }
  }
  // Fallback for non-IPC errors (should be rare)
  const msg = err instanceof Error ? err.message : String(err)
  if (/rate.limit|429/i.test(msg)) return 'rate_limit'
  if (/timeout|TIMEOUT/i.test(msg)) return 'network'
  return 'unknown'
}
```

### 7.3 Acceptance

- `grep "new Error(" src/infrastructure/jobs/spawn-worker-runtime.ts` → 0 hits
- `classifyLlmError(new WorkerRpcError('RATE_LIMITED', ...))` → `'rate_limit'`
- `classifyLlmError(new WorkerRpcError('PURPOSE_NOT_ALLOWED', ...))` → `'auth'`
- All existing mini-loop tests still pass

---

## 8. P1-4: Static Import + JOB_WORKER_ENTRY Backport

### 8.1 Problem

Only `worker-entry-subagent.ts` uses the double guard. `evolution/worker-entry.ts`, `memory/extract-worker.ts`, and `tests/fixtures/hello-worker.ts` only check `JOB_MODE === 'spawn'`.

### 8.2 Fix (Q7: safe, add guard unit test)

Three files: replace dynamic `import()` with static `import { runWorker }`, add `JOB_WORKER_ENTRY === '1'` guard.

Add `@worker-runtime` doc block to `spawn-worker-runtime.ts`:

```ts
/**
 * @worker-runtime
 * This module is statically imported by all worker entries.
 * MUST NOT execute side effects at top level (no process.stdin access,
 * no console.log, no connection setup). All runtime behavior must be
 * inside runWorker() or later.
 */
```

Add unit test:

```ts
test('importing spawn-worker-runtime has no side effects', async () => {
  const before = process.stdin.listenerCount('data')
  await import('../../src/infrastructure/jobs/spawn-worker-runtime')
  expect(process.stdin.listenerCount('data')).toBe(before)
})
```

### 8.3 Acceptance

- `grep -rn "JOB_MODE === 'spawn'" src/ tests/` → every match followed by `&& JOB_WORKER_ENTRY === '1'`
- Side-effect-free unit test passes

---

## 9. Integration Smoke Test

### 9.1 Scenarios (Q6: 4-layer assertions + negative + Promise gate)

**File**: `tests/integration/sub-agent-spawn-smoke.test.ts`

**Scenario A — Chat + Tool Round-Trip:**

```ts
test('real spawn: chat → tool → chat → result', async () => {
  const callLog: Array<{ round: number; toolName?: string }> = []
  const fakeProvider = createFakeProvider({
    responses: [
      { content: '', toolCalls: [{ id: 't1', name: 'echo', arguments: { msg: 'hello' } }], finishReason: 'tool_calls' },
      { content: 'Tool returned: hello', finishReason: 'stop' },
    ],
  })

  const callObserver: string[] = []
  const catalog = { get: (name: string) => name === 'echo' ? { ... } : undefined }

  const runner = createSpawnerSubAgentRunner({ spawner, registry, toolCatalog: catalog, ... })
  const result = await runner({ type: 'explore', prompt: 'test', ... })

  // 4-layer assertions (Q6):
  expect(result).not.toMatch(/<sub-agent-error/)    // (1) no error
  expect(result).toContain('Tool returned: hello')   // (2) LLM output includes tool result
  expect(callObserver).toEqual(['echo'])             // (3) tool really dispatched through IPC
  expect(callLog.length).toBe(2)                     // (4) mini-loop ran 2 rounds
}, 5000)
```

**Scenario A-negative — P0-1 Regression Lock:**

```ts
test('worker without dispatchTool rejects with WORKER_FATAL', async () => {
  // Env var to make createWorkerContext skip dispatchTool
  process.env.SKIP_DISPATCH_TOOL = '1'
  const runner = createSpawnerSubAgentRunner({ ... })
  await expect(runner({ ... })).rejects.toThrow(WorkerRpcError)
  delete process.env.SKIP_DISPATCH_TOOL
}, 5000)
```

**Scenario B — Shutdown Mid-Flight (Q6: Promise gate):**

```ts
test('real spawn: shutdown during chatComplete cancels cleanly', async () => {
  const chatStarted = Promise.withResolvers<void>()
  const releaseChat = Promise.withResolvers<void>()

  const fakeProvider = createFakeProvider({
    complete: async () => {
      chatStarted.resolve()
      await releaseChat.promise
      return { content: '...', finishReason: 'stop', usage: { input: 0, output: 0 } }
    },
  })

  const resultPromise = runner({ ... })
  await chatStarted.promise
  spawner.shutdown('graceful')
  releaseChat.resolve()
  await expect(resultPromise).rejects.toThrow(WorkerRpcError)
}, 8000)
```

### 9.2 CI Config

- `describe.concurrent: false`
- `testTimeout: 15000`
- `afterEach`: `await spawner.shutdown('immediate').catch(() => {})`
- Separate CI lane from unit test fast lane

### 9.3 Acceptance

- All 3 scenarios pass in CI
- `grep "callObserver\|toolSpy" tests/integration/sub-agent-spawn-smoke.test.ts` → >=1 hit
- `grep "instanceof WorkerRpcError" tests/integration/` → >=2 hits

---

## 10. P2-2 + P2-3: Hygiene

### 10.1 P2-2 — XML Escaping

```ts
function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;')
}
```

### 10.2 P2-3 — Dead `tool_calls` Branch

Replace empty return with `provider_inconsistent` diagnostic:

```ts
case 'tool_calls':
  log('warn', `provider returned finishReason=tool_calls but no toolCalls in response`)
  return {
    finalText: `<sub-agent-error type="provider_inconsistent" reason="finishReason=tool_calls but no toolCalls"></sub-agent-error>`,
    usage: totalUsage, toolCallCount, rounds: round + 1, finishReason: 'inconsistent',
  }
```

---

## 11. Implementation Order (Q8)

Blast-radius sort: type changes first, pure additions second, deletion of dead code last.

| Step | Content | LOC net | Dependencies |
|---|---|---|---|
| **0** | `WorkerRpcError` class + `WorkerRpcCode` enum | +30 | none |
| **1** | P0-4a: `ChatRequest.purpose` / `ChatResponse.finishReason` mandatory, adapter mapping | +30 / -0 | Step 0 (WorkerRpcError available, not used) |
| **2** | P0-1: `dispatchTool` IPC + `state.fatal` + error frame handling (Q3) | +120 | Step 0 (WorkerRpcError), Step 1 (Chat types done) |
| **3** | P0-2: dynamic enum via getter | +5 | none |
| **4** | P0-3 + P1-3: closure counter + `startEmitted` pairing (Q2) | +40 / -10 | Step 0 (WorkerRpcError for error path) |
| **5** | P0-4b: delete `finishReason` / `purpose` synthesis | -25 | Step 1 (adapter provides real values) |
| **6** | P1-1: `handleChatRequest` timeout + AbortController | +30 | Step 0 (WorkerRpcError), Step 1 (purpose already present) |
| **7** | P1-2 remainder: `rejectPending` unified signature, delete regex classify | +10 / -15 | Step 0 (WorkerRpcError already exists) |
| **8** | P1-4: 3 worker entries static import + guard + side-effect-free test | +15 / -15 | Step 7 (WorkerRpcError already imported by all workers) |
| **9** | Integration smoke test (scenarios A, A-neg, B) | +200 | Steps 0–8 (all P0/P1 complete) |
| **10** | P2-2 + P2-3: XML escape + dead branch fix | +15 | none |

### PR Split (Q8)

| PR | Steps | Net LOC | Description |
|---|---|---|---|
| **PR-1** | 0–5 | ~+250 | Core fixes: WorkerRpcError, dispatchTool, dynamic enum, counter, finishReason |
| **PR-2** | 6–8 | ~+70 | P1 wrap-up + backport |
| **PR-3** | 9 | +200 | Integration smoke (can parallel review with PR-2) |
| **PR-4** | 10 | +15 | Hygiene (can merge independently or with PR-3) |

PR-1 is the critical path.

---

## 12. Acceptance Criteria (Roll-Up)

1. `bun test tests/integration/sub-agent-spawn-smoke.test.ts` passes — first real-process sub-agent test
2. All existing fake-spawner e2e tests still pass
3. `grep -rn "JOB_MODE === 'spawn'" src/ tests/` → every match has `JOB_WORKER_ENTRY` guard
4. `grep -rn "concurrentByTurn" src/` → only inside `createSpawnerSubAgentRunner` closure
5. `grep "hasToolCalls ? 'tool_calls' : 'stop'" src/` → 0 hits
6. `grep "finishReason\?:" src/application/ports/` → 0 hits
7. Mini-loop unit tests cover all 4 `finishReason` branches with provider-faithful values
8. Dynamic enum unit test: post-wire registry mutation reflected in `parameters.properties.subagent_type.enum`
9. `classifyLlmError(new WorkerRpcError('PURPOSE_NOT_ALLOWED', ...))` → `'auth'`, not `'unknown'`
10. `subagent.completed { ok: false }` emitted on error path
11. `grep "new Error(" src/infrastructure/jobs/spawn-worker-runtime.ts` → 0 hits
12. import-side-effect-free unit test passes
13. All grep acceptances from individual sections satisfied

---

## 13. Out of Scope (Tracked for Future)

- P2-1: MiniLoopMessage format refactor (separate PR)
- Cross-process tool safety (file locking)
- Streaming `chatComplete`
- Per-sub-agent budget reporting to trace
- Sub-agent retry policy at runner level
- Provenance attribution in trace UIs
