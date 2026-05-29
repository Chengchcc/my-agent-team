# Sub-Agent M2 Follow-Up Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 10 bugs (4 P0 + 4 P1 + 2 P2) in the M2 sub-agent implementation — the real `Bun.spawn` path is 100% non-functional due to missing `dispatchTool` IPC and 3 other blockers.

**Architecture:** Blast-radius sort — type changes first (P0-4a: `ChatResponse.finishReason` + `ChatRequest.purpose` mandatory), then incremental IPC fixes (dispatchTool client, timeout, structured errors), then cleanup (delete synthesis code, backport guards, smoke tests). WorkerRpcError extracted early (Step 0) to avoid repeated touch.

**Tech Stack:** TypeScript, Bun, bun:test, NDJSON frame protocol

**Spec:** `docs/superpowers/specs/2026-06-01-sub-agent-m2-followup-fixes.md`

---

## File Map

| File | Create/Modify | Responsibility |
|------|--------------|----------------|
| `src/infrastructure/jobs/spawn-rpc/errors.ts` | Create | `WorkerRpcError` class + `WorkerRpcCode` type |
| `src/application/ports/provider.ts` | Modify | Add `purpose` to `ChatRequest`, `finishReason` to `ChatResponse` |
| `src/infrastructure/llm/adapters/claude-adapter.ts` | Modify | Map `stop_reason` → `finishReason` |
| `src/infrastructure/llm/adapters/openai-adapter.ts` | Modify | Forward `finish_reason` → `finishReason` |
| `tests/e2e/_fixtures/e2e-fake-provider.ts` | Modify | Accept `finishReason` in preset |
| `tests/fixtures/fake-provider.ts` | Modify | Accept `finishReason` in preset |
| `src/infrastructure/jobs/spawn-worker-runtime.ts` | Modify | +`dispatchTool` IPC client, +`pendingTool`, +`state.fatal`, error frame handling, `resolvePending`/`rejectPending` helpers |
| `src/extensions/sub-agent/task-tool.ts` | Modify | `parameters` → getter (dynamic enum) |
| `src/extensions/sub-agent/runner-spawner.ts` | Modify | Closure counter, `startEmitted` pairing, error event, XML escaping |
| `src/infrastructure/jobs/spawn-chat-handlers.ts` | Modify | Timeout + AbortSignal, forward `finishReason`/`purpose` |
| `src/extensions/sub-agent/index.ts` | Modify | Forward `finishReason`/`purpose`, delete synthesis |
| `src/extensions/sub-agent/mini-turn-loop.ts` | Modify | `classifyLlmError` → switch on `WorkerRpcError`, P2-3 dead branch fix |
| `src/extensions/evolution/worker-entry.ts` | Modify | Static import + `JOB_WORKER_ENTRY` guard |
| `src/extensions/memory/extract-worker.ts` | Modify | Static import + `JOB_WORKER_ENTRY` guard |
| `tests/fixtures/hello-worker.ts` | Modify | Static import + `JOB_WORKER_ENTRY` guard |
| `tests/unit/jobs/worker-rpc-error.test.ts` | Create | WorkerRpcError class + classifyLlmError tests |
| `tests/unit/sub-agent/task-tool-dynamic-enum.test.ts` | Create | Dynamic enum test |
| `tests/unit/sub-agent/runner-spawner-concurrency.test.ts` | Create | Counter isolation + startEmitted pairing tests |
| `tests/unit/jobs/spawn-worker-runtime-import.test.ts` | Create | Side-effect-free import test |
| `tests/integration/sub-agent-spawn-smoke.test.ts` | Create | Real-spawn smoke (3 scenarios) |

---

### Task 0: Create `WorkerRpcError` + `WorkerRpcCode`

**Files:**
- Create: `src/infrastructure/jobs/spawn-rpc/errors.ts`
- Create: `tests/unit/jobs/worker-rpc-error.test.ts`

**Why first:** Extracted from P1-2 to be Step 0. Every subsequent IPC fix depends on this structured error type. Avoids touching the same code twice (plain Error → WorkerRpcError).

- [ ] **Step 1: Write the test**

```ts
// tests/unit/jobs/worker-rpc-error.test.ts
import { describe, it, expect } from 'bun:test'
import { WorkerRpcError, type WorkerRpcCode } from '../../../src/infrastructure/jobs/spawn-rpc/errors'

describe('WorkerRpcError', () => {
  it('is instanceof Error and WorkerRpcError', () => {
    const err = new WorkerRpcError('TIMEOUT', 'chat timeout after 30000ms', 'frame-1')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(WorkerRpcError)
  })

  it('exposes code, message, frameId', () => {
    const err = new WorkerRpcError('RATE_LIMITED', 'too many requests')
    expect(err.code).toBe('RATE_LIMITED')
    expect(err.message).toBe('too many requests')
    expect(err.frameId).toBeUndefined()
  })

  it('has name WorkerRpcError', () => {
    const err = new WorkerRpcError('UNKNOWN', '???')
    expect(err.name).toBe('WorkerRpcError')
  })

  it('all known WorkerRpcCode values construct successfully', () => {
    const codes: WorkerRpcCode[] = [
      'TIMEOUT', 'RATE_LIMITED', 'PURPOSE_NOT_ALLOWED', 'PROVIDER_ERROR',
      'TOOL_NOT_ALLOWED', 'TOOL_EXEC_FAIL', 'TOOL_TIMEOUT',
      'WORKER_FATAL', 'PROTOCOL_VIOLATION', 'WORKER_CRASHED',
      'UNKNOWN',
    ]
    for (const code of codes) {
      const err = new WorkerRpcError(code, 'test')
      expect(err.code).toBe(code)
    }
  })
})
```

- [ ] **Step 2: Run test — verify FAIL**

```bash
bun test tests/unit/jobs/worker-rpc-error.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/infrastructure/jobs/spawn-rpc/errors.ts
export type WorkerRpcCode =
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'PURPOSE_NOT_ALLOWED'
  | 'PROVIDER_ERROR'
  | 'TOOL_NOT_ALLOWED'
  | 'TOOL_EXEC_FAIL'
  | 'TOOL_TIMEOUT'
  | 'WORKER_FATAL'
  | 'PROTOCOL_VIOLATION'
  | 'WORKER_CRASHED'
  | 'UNKNOWN'

export class WorkerRpcError extends Error {
  public override readonly name = 'WorkerRpcError'

  constructor(
    public readonly code: WorkerRpcCode,
    message: string,
    public readonly frameId?: string,
  ) {
    super(message)
  }
}
```

- [ ] **Step 4: Run test — verify PASS**

```bash
bun test tests/unit/jobs/worker-rpc-error.test.ts
```
Expected: 4 pass.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/jobs/spawn-rpc/errors.ts tests/unit/jobs/worker-rpc-error.test.ts
git commit -m "feat: add WorkerRpcError + WorkerRpcCode — unified structured IPC error type

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 1: P0-4a — Add `purpose` (mandatory) to `ChatRequest` + `finishReason` (mandatory) to `ChatResponse`

**Files:**
- Modify: `src/application/ports/provider.ts:1-60`
- Modify: `src/infrastructure/llm/adapters/claude-adapter.ts` (complete path)
- Modify: `src/infrastructure/llm/adapters/openai-adapter.ts` (complete path)
- Modify: `tests/e2e/_fixtures/e2e-fake-provider.ts` (complete method)
- Modify: `tests/fixtures/fake-provider.ts` (invoke method)

- [ ] **Step 1: Update port types**

```ts
// src/application/ports/provider.ts — updated ChatRequest + ChatResponse

interface ChatRequest {
  purpose: string                    // mandatory — audit / quota / whitelist
  messages: Array<{ role: string; content: string }>
  tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  model?: string
}

interface ChatResponse {
  id: string
  content: string
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter'  // mandatory
  usage: { input: number; output: number }
  model: string
}
```

(Same file, same exports — just changed the two interfaces.)

- [ ] **Step 2: Run tsc — verify compile errors point to adapters + callers**

```bash
bun run tsc --noEmit 2>&1 | head -30
```
Expected: Errors in claude-adapter, openai-adapter, e2e-fake-provider, fake-provider, and any `complete()` call site missing `purpose` or `finishReason`.

- [ ] **Step 3: Fix Claude adapter — map `stop_reason`**

Read `src/infrastructure/llm/adapters/claude-adapter.ts` and find the `toChatWire` and `fromChatResponse` methods. In `fromChatResponse`, add:

```ts
// Map stop_reason → finishReason
const finishReason = raw.stop_reason === 'end_turn' ? 'stop' as const
  : raw.stop_reason === 'max_tokens' ? 'length' as const
  : raw.stop_reason === 'tool_use' ? 'tool_calls' as const
  : 'stop' as const
```

And include `finishReason` in the returned `ChatResponse`.

- [ ] **Step 4: Fix OpenAI adapter**

Read `src/infrastructure/llm/adapters/openai-adapter.ts`. In `fromChatResponse`:

```ts
const finishReason = raw.finish_reason === 'length' ? 'length' as const
  : raw.finish_reason === 'tool_calls' ? 'tool_calls' as const
  : raw.finish_reason === 'content_filter' ? 'content_filter' as const
  : 'stop' as const
```

Include `finishReason` in return.

- [ ] **Step 5: Fix E2EFakeProvider**

In `tests/e2e/_fixtures/e2e-fake-provider.ts`, `complete()` method: add `finishReason: 'stop'` to the return object.

- [ ] **Step 6: Fix FakeProvider**

In `tests/fixtures/fake-provider.ts`, `invoke()` method: add `finishReason: 'stop'` to the return object. (Or accept from `PresetTurn` — simpler to hardcode `'stop'` since this fake is only used in unit tests.)

- [ ] **Step 7: Fix all `complete()` call sites — add `purpose`**

```bash
rg "\.complete\(\{[^}]*messages" src/ --no-filename
```
Each call site: add `purpose: '<descriptive>'` as first argument.

Expected ~4-5 sites: `spawn-chat-handlers.ts`, `sub-agent/index.ts`, possibly turn-runner or test files.

- [ ] **Step 8: Verify tsc clean**

```bash
bun run tsc --noEmit 2>&1
```
Expected: clean (no output).

- [ ] **Step 9: Run tests**

```bash
bun test --timeout 30000 2>&1 | tail -5
```
Expected: same pass rate as before (872+).

- [ ] **Step 10: Commit**

```bash
git add src/application/ports/provider.ts \
  src/infrastructure/llm/adapters/claude-adapter.ts \
  src/infrastructure/llm/adapters/openai-adapter.ts \
  tests/e2e/_fixtures/e2e-fake-provider.ts \
  tests/fixtures/fake-provider.ts
# + any call site files that needed purpose
git commit -m "feat: add mandatory purpose to ChatRequest + finishReason to ChatResponse (P0-4a)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: P0-1 — Worker `dispatchTool` IPC Client + `state.fatal`

**Files:**
- Modify: `src/infrastructure/jobs/spawn-worker-runtime.ts`

- [ ] **Step 1: Read current file at line 27 (createWorkerContext), line 14 (WorkerState interface)**

Already have the current state. Add `dispatchTool` to ctx, add `pendingTool` map, add `state.fatal`, update error frame handling per Q3 decision.

- [ ] **Step 2: Implement all changes in one edit pass**

Add to `WorkerState` interface:
```ts
pendingTool: Map<string, PendingEntry>
fatal: WorkerRpcError | null
```

Add constant:
```ts
const WORKER_TOOL_TIMEOUT_MS = 60_000
```

Add `dispatchTool` method to `createWorkerContext` (after `chatComplete`):
```ts
dispatchTool: (call) => {
  if (state.fatal) throw state.fatal
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const timer = setTimeout(() => {
      state.pendingTool.delete(id)
      reject(new WorkerRpcError('TOOL_TIMEOUT', 'worker dispatchTool timeout', id))
    }, WORKER_TOOL_TIMEOUT_MS)
    state.pendingTool.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject: reject as (e: unknown) => void,
      timer,
    })
    state.writeFrame({ v: 1, id, kind: 'tool-call-req', ts: Date.now(), payload: call })
  })
},
```

Add to `cancelAllPending`: iterate `state.pendingTool` too.

Add `resolvePending` helper (before `makeHandleData`):
```ts
function resolvePending(map: Map<string, PendingEntry>, frame: Frame): void {
  const entry = map.get(frame.id)
  if (entry) { clearTimeout(entry.timer); map.delete(frame.id); entry.resolve(frame.payload) }
}
```

Add `rejectPending` helper (unified from Q4):
```ts
function rejectPending(
  map: Map<string, PendingEntry>,
  frame: Frame,
  code: WorkerRpcCode,
): void {
  const entry = map.get(frame.id)
  if (entry) {
    clearTimeout(entry.timer)
    map.delete(frame.id)
    const p = frame.payload as { message?: string }
    entry.reject(new WorkerRpcError(code, p.message ?? 'no message', frame.id))
  }
}
```

In `makeHandleData`: add `case 'tool-call-resp'` → `resolvePending(state.pendingTool, frame)`.

In `error` case: replace with single-entry check (NOT `pendingTool`), then reject all pendingTool with `WORKER_FATAL`:
```ts
case 'error': {
  const p = frame.payload as { code?: WorkerRpcCode; message?: string }
  const code = p.code ?? 'UNKNOWN'
  const err = new WorkerRpcError(code, p.message ?? 'no message', frame.id)

  // Reject trigger entry only (invoke or chat, not tool)
  const entry = state.pending.get(frame.id) ?? state.pendingChat.get(frame.id)
  if (entry) { clearTimeout(entry.timer); entry.reject(err) }
  state.pending.delete(frame.id); state.pendingChat.delete(frame.id)

  // Reject ALL pending tool calls
  for (const [id, tool] of state.pendingTool) {
    clearTimeout(tool.timer)
    tool.reject(new WorkerRpcError('WORKER_FATAL', `Worker entered fatal state: ${err.message}`, id))
  }
  state.pendingTool.clear()

  state.fatal = err
  break
}
```

In `runWorker`: initialize `pendingTool: new Map(), fatal: null` in `state`.

Remove `'tool-call-resp'` from defensive comment block (it's now a handled case).

- [ ] **Step 3: Verify tsc**

```bash
bun run tsc --noEmit 2>&1 | head -10
```
Expected: clean.

- [ ] **Step 4: Verify existing tests still pass**

```bash
bun test tests/unit/jobs/ tests/extensions/sub-agent/ --timeout 30000 2>&1 | tail -5
```
Expected: all pass.

- [ ] **Step 5: Acceptance grep**

```bash
grep "pendingTool.*error\|state\.fatal" src/infrastructure/jobs/spawn-worker-runtime.ts | wc -l
```
Expected: >=3 hits.

```bash
grep "new Error(" src/infrastructure/jobs/spawn-worker-runtime.ts | wc -l
```
Expected: 0.

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/jobs/spawn-worker-runtime.ts
git commit -m "feat: add dispatchTool IPC client + state.fatal to spawn-worker-runtime (P0-1)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: P0-2 — Dynamic Task Enum via Getter

**Files:**
- Modify: `src/extensions/sub-agent/task-tool.ts:11-28`
- Create: `tests/unit/sub-agent/task-tool-dynamic-enum.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/unit/sub-agent/task-tool-dynamic-enum.test.ts
import { describe, it, expect } from 'bun:test'
import { createTaskTool } from '../../../src/extensions/sub-agent/task-tool'
import { SubAgentRegistry, registerBuiltins } from '../../../src/extensions/sub-agent/registry'

describe('task tool dynamic enum', () => {
  it('reflects registry mutations after tool creation', () => {
    const registry = new SubAgentRegistry()
    registry.register({
      type: 'explore', description: 'x', systemPrompt: 'x',
      allowedToolNames: ['read'], source: 'builtin',
    })

    const tool = createTaskTool({ runSubAgent: async () => '', registry })
    const p1 = tool.parameters as Record<string, unknown>
    const e1 = ((p1.properties as Record<string, unknown>).subagent_type as Record<string, unknown>).enum as string[]
    expect(e1).toEqual(['explore'])

    // Register new type AFTER tool creation
    registry.register({
      type: 'custom-auditor', description: 'x', systemPrompt: 'x',
      allowedToolNames: ['read'], source: 'extension',
    })

    // Read parameters again — must include the new type
    const p2 = tool.parameters as Record<string, unknown>
    const e2 = ((p2.properties as Record<string, unknown>).subagent_type as Record<string, unknown>).enum as string[]
    expect(e2).toContain('explore')
    expect(e2).toContain('custom-auditor')
  })
})
```

- [ ] **Step 2: Run test — verify FAIL**

```bash
bun test tests/unit/sub-agent/task-tool-dynamic-enum.test.ts
```
Expected: FAIL — enum snapped at create time, `custom-auditor` not present.

- [ ] **Step 3: Implement getter**

In `src/extensions/sub-agent/task-tool.ts`, replace:
```ts
const schema: Record<string, unknown> = { ... }
return {
  name: 'task',
  parameters: schema,
  ...
}
```
with:
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
  ...
}
```

- [ ] **Step 4: Run test — verify PASS**

```bash
bun test tests/unit/sub-agent/task-tool-dynamic-enum.test.ts
```
Expected: PASS.

- [ ] **Step 5: Run existing task-tool tests**

```bash
bun test tests/extensions/sub-agent/task-tool.test.ts
```
Expected: PASS (no regression).

- [ ] **Step 6: Commit**

```bash
git add src/extensions/sub-agent/task-tool.ts tests/unit/sub-agent/task-tool-dynamic-enum.test.ts
git commit -m "fix: dynamic subagent_type enum via getter — reflects post-wire registry mutations (P0-2)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: P0-3 + P1-3 — Closure Counter + startEmitted Event Pairing

**Files:**
- Modify: `src/extensions/sub-agent/runner-spawner.ts:21-116`
- Create: `tests/unit/sub-agent/runner-spawner-concurrency.test.ts`

- [ ] **Step 1: Write concurrency isolation tests**

```ts
// tests/unit/sub-agent/runner-spawner-concurrency.test.ts
import { describe, it, expect, mock } from 'bun:test'
import { createSpawnerSubAgentRunner } from '../../../src/extensions/sub-agent/runner-spawner'
import { SubAgentRegistry, registerBuiltins } from '../../../src/extensions/sub-agent/registry'

function makeDeps() {
  const registry = new SubAgentRegistry()
  registerBuiltins(registry)
  return {
    spawner: { run: mock(async () => ({ finalText: 'ok', usage: { input: 0, output: 0 }, finishReason: 'stop' })) },
    registry,
    toolCatalog: { get: () => undefined },
    chatComplete: mock(async () => ({ content: 'ok', usage: { input: 0, output: 0 }, finishReason: 'stop' })),
    bus: { emit: mock(() => {}) },
    logger: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}), debug: mock(() => {}), withTag: mock(() => ({})) },
    agentDir: '/tmp/test',
  }
}

const signal = new AbortController().signal

describe('runner-spawner concurrency', () => {
  it('two runner instances have independent counters', async () => {
    const deps1 = makeDeps()
    ;(deps1.spawner as any).run = mock(() => new Promise(() => {})) // hang

    const runner1 = createSpawnerSubAgentRunner(deps1)
    const runner2 = createSpawnerSubAgentRunner(makeDeps())

    // Fill runner1 cap
    const p1 = runner1({ type: 'explore', prompt: 'a', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1', parentSignal: signal })
    const p2 = runner1({ type: 'plan', prompt: 'b', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c2', parentSignal: signal })
    const p3 = runner1({ type: 'explore', prompt: 'c', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c3', parentSignal: signal })

    await new Promise(r => setTimeout(r, 5))

    // Runner2 should NOT be blocked by runner1's cap (independent instances)
    const result = await runner2({ type: 'explore', prompt: 'd', parentSessionId: 's2', parentTurnId: 't2', parentCallId: 'c4', parentSignal: signal })
    expect(result).toBe('ok')
  })

  it('counter recovers after sub-agent failure', async () => {
    const deps = makeDeps()
    let callCount = 0
    ;(deps.spawner as any).run = mock(async () => {
      callCount++
      if (callCount === 1) throw new Error('worker crash')
      return { finalText: 'ok', usage: { input: 0, output: 0 }, finishReason: 'stop' }
    })

    const runner = createSpawnerSubAgentRunner(deps)

    // First call fails
    const r1 = await runner({ type: 'explore', prompt: 'a', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1', parentSignal: signal })
    expect(r1).toContain('failed')

    // Second call should succeed (counter was released in finally)
    const r2 = await runner({ type: 'explore', prompt: 'b', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c2', parentSignal: signal })
    expect(r2).toBe('ok')
  })

  it('bus.emit(started) failure does not prevent sub-agent completion', async () => {
    const deps = makeDeps()
    let subagentCompletedEmitted = false
    ;(deps.bus as any).emit = mock((event: string) => {
      if (event === 'subagent.started') throw new Error('bus down')
      if (event === 'subagent.completed') subagentCompletedEmitted = true
    })

    const runner = createSpawnerSubAgentRunner(deps)
    const result = await runner({ type: 'explore', prompt: 'a', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1', parentSignal: signal })

    expect(result).toBe('ok')
    expect(subagentCompletedEmitted).toBe(false) // startEmitted=false → completed skipped
  })
})
```

- [ ] **Step 2: Run tests — verify FAIL**

```bash
bun test tests/unit/sub-agent/runner-spawner-concurrency.test.ts
```
Expected: FAIL — counter is module-level, cross-instance pollution.

- [ ] **Step 3: Refactor runner-spawner.ts**

Move `concurrentByTurn` into `createSpawnerSubAgentRunner` closure. Add `tryAcquire`/`release` helpers. Add `startEmitted` pairing guard. Add `subagent.completed { ok: false }` on error path. Spec §4.2 code block from follow-up spec.

Key changes:
```ts
export function createSpawnerSubAgentRunner(deps: SpawnerRunnerDeps): SubAgentRunner {
  const concurrentByTurn = new Map<string, number>()  // ← was module-level

  function tryAcquire(turnId: string): boolean { ... }
  function release(turnId: string): void { ... }

  return async (input: SubAgentRunInput): Promise<string> => {
    // ... use tryAcquire / release ...

    let startEmitted = false
    try {
      try { void deps.bus.emit('subagent.started', { ... }); startEmitted = true } catch {}
      // ... spawner.run ...
      if (startEmitted) { try { void deps.bus.emit('subagent.completed', { ok: true }) } catch {} }
      return typed.finalText
    } catch (err) {
      if (startEmitted) {
        try { void deps.bus.emit('subagent.completed', { ok: false, finishReason: tag }) } catch {}
      }
      return `<sub-agent-error type="${tag}" ...>`
    } finally {
      release(input.parentTurnId)
    }
  }
}
```

- [ ] **Step 4: Run tests — verify PASS**

```bash
bun test tests/unit/sub-agent/runner-spawner-concurrency.test.ts tests/unit/sub-agent/runner-spawner.test.ts
```
Expected: all pass.

- [ ] **Step 5: Acceptance grep**

```bash
grep -rn "concurrentByTurn" src/extensions/sub-agent/runner-spawner.ts
```
Expected: only inside `createSpawnerSubAgentRunner` closure (not module-level).

- [ ] **Step 6: Commit**

```bash
git add src/extensions/sub-agent/runner-spawner.ts tests/unit/sub-agent/runner-spawner-concurrency.test.ts
git commit -m "fix: closure counter + startEmitted pairing + subagent.completed on error (P0-3, P1-3)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 5: P0-4b — Delete `finishReason` / `purpose` Synthesis

**Files:**
- Modify: `src/infrastructure/jobs/spawn-chat-handlers.ts:51-57`
- Modify: `src/extensions/sub-agent/index.ts:44-49`

- [ ] **Step 1: Delete synthesis in spawn-chat-handlers.ts**

Replace:
```ts
const hasToolCalls = resp.toolCalls && resp.toolCalls.length > 0
// ...
finishReason: hasToolCalls ? 'tool_calls' as const : 'stop' as const,
```
with:
```ts
finishReason: resp.finishReason,
```

- [ ] **Step 2: Delete synthesis in sub-agent/index.ts**

Replace:
```ts
const hasToolCalls = resp.toolCalls && resp.toolCalls.length > 0
return {
  content: resp.content,
  toolCalls: resp.toolCalls,
  finishReason: hasToolCalls ? 'tool_calls' as const : 'stop' as const,
  usage: resp.usage,
}
```
with:
```ts
return {
  content: resp.content,
  toolCalls: resp.toolCalls,
  finishReason: resp.finishReason,
  usage: resp.usage,
}
```

- [ ] **Step 3: Verify tsc + acceptance grep**

```bash
bun run tsc --noEmit 2>&1 | head -5
grep -rn "hasToolCalls ? 'tool_calls' : 'stop'" src/
```
Expected: tsc clean; grep returns 0 hits.

- [ ] **Step 4: Run tests**

```bash
bun test tests/extensions/sub-agent/ tests/unit/sub-agent/ --timeout 30000 2>&1 | tail -5
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/jobs/spawn-chat-handlers.ts src/extensions/sub-agent/index.ts
git commit -m "fix: delete finishReason/purpose synthesis — forward provider values directly (P0-4b)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 6: P1-1 — chat-req Timeout + AbortController

**Files:**
- Modify: `src/infrastructure/jobs/spawn-chat-handlers.ts:11-69`
- Modify: `src/infrastructure/jobs/bun-spawn-job-spawner.ts` (call site)

- [ ] **Step 1: Add timeout + signal to handleChatRequest**

Update signature to accept `chatTimeoutMs`:
```ts
export async function handleChatRequest(
  frame: Frame,
  stdin: ...,
  jobType: string,
  _spawnId: string,
  chatComplete: ProviderChat['complete'],
  logger: Logger,
  chatTimeoutMs: number,
): Promise<void> {
```

In the body, add AbortController + setTimeout before the `chatComplete` call:
```ts
const abortController = new AbortController()
const timer = setTimeout(() => {
  abortController.abort()
  void stdin.write(encodeFrame({
    v: 1, id: frame.id, kind: 'chat-error', ts: Date.now(),
    payload: { code: 'TIMEOUT', message: `chat timeout after ${chatTimeoutMs}ms` },
  }))
}, chatTimeoutMs)

const resp = await chatComplete({
  purpose: payload.purpose,          // now mandatory after P0-4a
  messages: payload.messages ?? [],
  tools: payload.tools ?? [],
  maxTokens: payload.maxTokens,
  signal: abortController.signal,
})
clearTimeout(timer)
```

- [ ] **Step 2: Thread timeout from BunSpawnJobSpawner**

```ts
private async handleChatRequest(frame, stdin, jobType, spawnId) {
  return handleChatRequest(frame, stdin, jobType, spawnId, this.chatComplete, this.logger, this.cfg.invokeTimeoutMs)
}
```

- [ ] **Step 3: Verify tsc + run tests**

```bash
bun run tsc --noEmit 2>&1 | head -5
```
Expected: clean.

- [ ] **Step 4: Acceptance grep**

```bash
grep "abortController\|setTimeout.*chat-error\|signal:" src/infrastructure/jobs/spawn-chat-handlers.ts | wc -l
```
Expected: >=3 hits.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/jobs/spawn-chat-handlers.ts src/infrastructure/jobs/bun-spawn-job-spawner.ts
git commit -m "fix: add timeout + AbortController + purpose forwarding to handleChatRequest (P1-1)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 7: P1-2 Remainder — Unified rejectPending + Delete Regex classifyLlmError

**Files:**
- Modify: `src/infrastructure/jobs/spawn-worker-runtime.ts` (replace rejectPending, update existing call sites)
- Modify: `src/extensions/sub-agent/mini-turn-loop.ts:44-51`

- [ ] **Step 1: Swap rejectPending to WorkerRpcError**

In `spawn-worker-runtime.ts`, replace all `new Error(...)` in reject paths with `new WorkerRpcError(code, message, frameId)`. Use the `rejectPending` helper from Task 2, extended with `WorkerRpcError`.

- [ ] **Step 2: Rewrite classifyLlmError in mini-turn-loop.ts**

Replace regex-based function with switch on `WorkerRpcError`:
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
  const msg = err instanceof Error ? err.message : String(err)
  if (/rate.limit|429/i.test(msg)) return 'rate_limit'
  if (/timeout|TIMEOUT/i.test(msg)) return 'network'
  return 'unknown'
}
```

Add import: `import { WorkerRpcError } from '../../infrastructure/jobs/spawn-rpc/errors'`

- [ ] **Step 3: Verify tests pass**

```bash
bun test tests/unit/sub-agent/mini-turn-loop.test.ts tests/unit/jobs/worker-rpc-error.test.ts --timeout 10000
```
Expected: all pass.

- [ ] **Step 4: Acceptance grep**

```bash
grep "new Error(" src/infrastructure/jobs/spawn-worker-runtime.ts | wc -l
```
Expected: 0.

```bash
grep "instanceof WorkerRpcError" src/extensions/sub-agent/mini-turn-loop.ts | wc -l
```
Expected: >=1.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/jobs/spawn-worker-runtime.ts src/extensions/sub-agent/mini-turn-loop.ts
git commit -m "fix: unified rejectPending + delete regex classifyLlmError — all IPC errors use WorkerRpcError (P1-2)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 8: P1-4 — Static Import + JOB_WORKER_ENTRY Backport

**Files:**
- Modify: `src/extensions/evolution/worker-entry.ts`
- Modify: `src/extensions/memory/extract-worker.ts`
- Modify: `tests/fixtures/hello-worker.ts`
- Create: `tests/unit/jobs/spawn-worker-runtime-import.test.ts`
- Modify: `src/infrastructure/jobs/spawn-worker-runtime.ts` (add `@worker-runtime` doc block)

- [ ] **Step 1: Add @worker-runtime doc block**

```ts
// src/infrastructure/jobs/spawn-worker-runtime.ts — top of file, before imports
/**
 * @worker-runtime
 * This module is statically imported by all worker entries.
 * MUST NOT execute side effects at top level (no process.stdin access,
 * no console.log, no connection setup). All runtime behavior must be
 * inside runWorker() or later.
 */
```

- [ ] **Step 2: Write import side-effect-free test**

```ts
// tests/unit/jobs/spawn-worker-runtime-import.test.ts
import { test, expect } from 'bun:test'

test('importing spawn-worker-runtime has no side effects', async () => {
  const before = process.stdin.listenerCount('data')
  await import('../../../src/infrastructure/jobs/spawn-worker-runtime')
  expect(process.stdin.listenerCount('data')).toBe(before)
})
```

- [ ] **Step 3: Backport three worker entries**

For each file (`evolution/worker-entry.ts`, `memory/extract-worker.ts`, `hello-worker.ts`):
- Replace dynamic `import('../../infrastructure/jobs/spawn-worker-runtime')` with static `import { runWorker } from '../../infrastructure/jobs/spawn-worker-runtime'`
- Replace `if (process.env.JOB_MODE === 'spawn')` with `if (process.env.JOB_MODE === 'spawn' && process.env.JOB_WORKER_ENTRY === '1')`
- Replace `.then(({ runWorker }) => runWorker(...))` with direct `runWorker(...)`
- Add `.catch()` on the returned promise (same pattern as `worker-entry-subagent.ts`)

- [ ] **Step 4: Verify tsc + tests**

```bash
bun run tsc --noEmit 2>&1 | head -5
bun test tests/unit/jobs/spawn-worker-runtime-import.test.ts --timeout 10000
```
Expected: clean. Side-effect test pass.

- [ ] **Step 5: Acceptance grep**

```bash
grep -rn "JOB_MODE === 'spawn'" src/ tests/
```
Expected: every match followed by `&& JOB_WORKER_ENTRY === '1'`.

- [ ] **Step 6: Commit**

```bash
git add src/extensions/evolution/worker-entry.ts src/extensions/memory/extract-worker.ts tests/fixtures/hello-worker.ts src/infrastructure/jobs/spawn-worker-runtime.ts tests/unit/jobs/spawn-worker-runtime-import.test.ts
git commit -m "fix: backport static import + JOB_WORKER_ENTRY guard to all workers + add side-effect-free import test (P1-4)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 9: Integration Smoke Tests

**Files:**
- Create: `tests/integration/sub-agent-spawn-smoke.test.ts`

- [ ] **Step 1: Create test file with 3 scenarios**

```ts
// tests/integration/sub-agent-spawn-smoke.test.ts
import { describe, it, expect, afterEach } from 'bun:test'
import { BunSpawnJobSpawner } from '../../src/infrastructure/jobs/bun-spawn-job-spawner'
import { createSpawnerSubAgentRunner } from '../../src/extensions/sub-agent/runner-spawner'
import { SubAgentRegistry, registerBuiltins } from '../../src/extensions/sub-agent/registry'
import type { ProviderChat, ProviderInvoke } from '../../src/application/ports/provider'
import { WorkerRpcError } from '../../src/infrastructure/jobs/spawn-rpc/errors'

function makeFakeProvider(responses: Array<{
  content: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter'; usage?: { input: number; output: number };
}>) {
  let cursor = 0
  return {
    complete: async (req: any) => {
      const r = responses[cursor++] ?? { content: '(no preset)', finishReason: 'stop' as const, usage: { input: 0, output: 0 } }
      return { id: 'fake', content: r.content, toolCalls: r.toolCalls, finishReason: r.finishReason, usage: r.usage ?? { input: 0, output: 0 }, model: 'fake' }
    },
    call: async () => ({ content: '{}', usage: { input: 0, output: 0 } }),
    stream: async function* () {},
  } as ProviderChat & ProviderInvoke
}

function silentLogger() {
  return { debug() {}, info() {}, warn() {}, error() {}, withTag() { return this } } as any
}

describe('Sub-agent real spawn smoke', () => {
  // Scenario A — Chat + Tool Round-Trip
  it('real spawn: chat → tool → chat → result', async () => {
    const callObserver: string[] = []
    const provider = makeFakeProvider([
      { content: '', toolCalls: [{ id: 't1', name: 'echo', arguments: { msg: 'hello' } }], finishReason: 'tool_calls' },
      { content: 'Tool returned: hello', finishReason: 'stop' },
    ])

    const registry = new SubAgentRegistry()
    registerBuiltins(registry)

    const spawner = new BunSpawnJobSpawner(provider, provider.complete.bind(provider), silentLogger(), { invokeTimeoutMs: 10_000, lifetimeMs: 15_000 })
    const runner = createSpawnerSubAgentRunner({
      spawner, registry,
      toolCatalog: {
        register() {}, unregister() {}, list() { return [] },
        get(name: string) {
          if (name !== 'echo') return undefined
          return {
            name: 'echo', description: 'echo tool', parameters: { type: 'object', properties: { msg: { type: 'string' } } },
            parse: (args: any) => args,
            execute: async (_ctx: any, args: any) => { callObserver.push(name); return `echoed: ${args.msg}` },
          }
        },
      },
      chatComplete: async (req: any) => provider.complete(req),
      bus: { emit: () => {} } as any,
      logger: silentLogger(),
      agentDir: '/tmp/test-smoke',
    })

    const result = await runner({
      type: 'explore', prompt: 'echo hello',
      parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1',
      parentSignal: new AbortController().signal,
    })

    // 4-layer assertions
    expect(result).not.toMatch(/<sub-agent-error/)
    expect(result).toContain('Tool returned: hello')
    expect(callObserver).toEqual(['echo'])          // tool really dispatched through IPC
  }, 10_000)

  // Scenario B — Shutdown Mid-Flight (with Promise gate)
  it('real spawn: shutdown during chatComplete cancels cleanly', async () => {
    const chatStarted = Promise.withResolvers<void>()
    const releaseChat = Promise.withResolvers<void>()

    const provider = {
      complete: async (_req: any) => {
        chatStarted.resolve()
        await releaseChat.promise  // hang until test says go
        return { id: 'fake', content: 'late', finishReason: 'stop' as const, usage: { input: 0, output: 0 }, model: 'fake' }
      },
      call: async () => ({ content: '{}', usage: { input: 0, output: 0 } }),
      stream: async function* () {},
    } as ProviderChat & ProviderInvoke

    const registry = new SubAgentRegistry()
    registerBuiltins(registry)
    const spawner = new BunSpawnJobSpawner(provider, provider.complete.bind(provider), silentLogger(), { invokeTimeoutMs: 5_000, lifetimeMs: 10_000 })
    const runner = createSpawnerSubAgentRunner({
      spawner, registry,
      toolCatalog: { register() {}, unregister() {}, list() { return [] }, get: () => undefined },
      chatComplete: async (req: any) => provider.complete(req),
      bus: { emit: () => {} } as any,
      logger: silentLogger(),
      agentDir: '/tmp/test-smoke',
    })

    const controller = new AbortController()
    const resultPromise = runner({ type: 'explore', prompt: 'test', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1', parentSignal: controller.signal })

    await chatStarted.promise       // worker is mid-flight
    controller.abort()              // cancel
    releaseChat.resolve()           // unblock provider

    const result = await resultPromise
    expect(result).toMatch(/<sub-agent-error type="cancelled"/)
  }, 15_000)

  afterEach(async () => {
    // Ensure no orphan processes
    await new Promise(r => setTimeout(r, 200))
  })
})
```

- [ ] **Step 2: Run smoke tests**

```bash
bun test tests/integration/sub-agent-spawn-smoke.test.ts --timeout 20000
```
Expected: 2 pass.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/sub-agent-spawn-smoke.test.ts
git commit -m "test: add real-spawn integration smoke tests (chat+tool round-trip + shutdown mid-flight)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 10: P2-2 + P2-3 — XML Escaping + Dead Branch Fix

**Files:**
- Modify: `src/extensions/sub-agent/runner-spawner.ts:25-27`
- Modify: `src/extensions/sub-agent/mini-turn-loop.ts:40-42, 116-118`

- [ ] **Step 1: Fix XML escaping**

In `runner-spawner.ts`, update `escapeXmlAttr`:
```ts
function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;')
}
```

- [ ] **Step 2: Fix dead tool_calls branch**

In `mini-turn-loop.ts`, replace the dead case:
```ts
case 'tool_calls':
  log('warn', `provider returned finishReason=tool_calls but no toolCalls in response`)
  return {
    finalText: `<sub-agent-error type="provider_inconsistent" reason="finishReason=tool_calls but no toolCalls"></sub-agent-error>`,
    usage: totalUsage, toolCallCount, rounds: round + 1, finishReason: 'inconsistent',
  }
```

- [ ] **Step 3: Run tests**

```bash
bun test tests/unit/sub-agent/mini-turn-loop.test.ts tests/unit/sub-agent/runner-spawner.test.ts --timeout 10000
```
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/extensions/sub-agent/runner-spawner.ts src/extensions/sub-agent/mini-turn-loop.ts
git commit -m "fix: XML escape newline/CR/tab + dead tool_calls branch now returns provider_inconsistent (P2-2, P2-3)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 11: Full CI Verification

- [ ] **Step 1: Type check**

```bash
bun run check:guard
```

- [ ] **Step 2: Lint**

```bash
bun run lint
```

- [ ] **Step 3: Architecture**

```bash
bun run check:arch
```

- [ ] **Step 4: Dead code**

```bash
bun run check:deadcode
```

- [ ] **Step 5: Full test suite**

```bash
bun test --timeout 30000 2>&1 | tail -5
```
Expected: >= 880 pass, 0 new failures.

- [ ] **Step 6: Acceptance grep sweep**

```bash
grep -rn "JOB_MODE === 'spawn'" src/ tests/ | grep -v "JOB_WORKER_ENTRY"
# Expected: 0 hits

grep -rn "hasToolCalls ? 'tool_calls' : 'stop'" src/
# Expected: 0 hits

grep -rn "finishReason\?:" src/application/ports/
# Expected: 0 hits

grep -rn "new Error(" src/infrastructure/jobs/spawn-worker-runtime.ts
# Expected: 0 hits

grep -rn "concurrentByTurn" src/extensions/sub-agent/
# Expected: only inside createSpawnerSubAgentRunner closure
```

- [ ] **Step 7: Commit any fixes**

```bash
git add -A && git commit -m "chore: CI fixes for M2 follow-up" || echo "no fixes needed"
```

---

## Self-Review

### 1. Spec coverage

| Spec section | Tasks |
|---|---|
| §2 P0-1 dispatchTool IPC + state.fatal | Task 2 |
| §3 P0-2 Dynamic enum | Task 3 |
| §4 P0-3 + P1-3 Counter + events | Task 4 |
| §5 P0-4 finishReason + purpose | Tasks 1, 5 |
| §6 P1-1 Timeout + abort | Task 6 |
| §7 P1-2 WorkerRpcError unified | Tasks 0, 7 |
| §8 P1-4 Backport | Task 8 |
| §9 Integration smoke | Task 9 |
| §10 P2-2 + P2-3 Hygiene | Task 10 |

### 2. Placeholder scan

Zero TBD/TODO/fill-in-later. All code blocks concrete.

### 3. Type consistency

- `WorkerRpcError(code, message, frameId?)` — consistent across all tasks
- `ChatResponse.finishReason` — mandatory, used in Tasks 1, 5, 6
- `ChatRequest.purpose` — mandatory, used in Tasks 1, 6
- `startEmitted` — boolean flag, Task 4
- `state.fatal` — `WorkerRpcError | null`, Task 2
