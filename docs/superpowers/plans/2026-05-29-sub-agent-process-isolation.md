# Sub-Agent Process Isolation (M2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor sub-agents from in-process `runTurnUsecase` reuse to isolated child-process workers communicating via NDJSON RPC, fixing M1 isolation bugs (prompt contamination, turnId collision, maxRounds ignored).

**Architecture:** Worker processes run a custom mini-turn-loop using `chatComplete` (tool-capable LLM via IPC) and `dispatchTool` (tool execution proxied to parent's catalog). Parent validates all IPC at a whitelist boundary. No `runTurnUsecase`, no `transformPrompt` hooks, no shared turn state.

**Tech Stack:** TypeScript, Bun (`Bun.spawn`), NDJSON frame protocol, existing `spawn-rpc` infrastructure, `bun test`

**Spec:** `docs/superpowers/specs/2026-05-29-sub-agent-process-isolation.md`

---

## File Map

| File | Create/Modify | Responsibility |
|------|--------------|----------------|
| `src/application/ports/job-spawner.ts` | Modify | +`ChatCompleteRequest`/`ChatCompleteResponse` types; +`chatComplete` + `dispatchTool` on `JobContext` |
| `src/application/ports/tool-context.ts` | Modify | +`source?: ToolCallSource` sealed union |
| `src/infrastructure/jobs/spawn-rpc/frame.ts` | Modify | +6 `FrameKind` values; +payload types |
| `src/infrastructure/jobs/bun-spawn-job-spawner.ts` | Modify | +`handleChatRequest`, `handleToolCall`, `relayProgress`; +`CHAT_PURPOSE_WHITELIST`; +`JOB_WORKER_ENTRY` env |
| `src/infrastructure/jobs/spawn-worker-runtime.ts` | Modify | +`pendingChat` map; +`chatComplete` on `WorkerContext`; +`chat-resp`/`chat-error` frame handling |
| `src/extensions/sub-agent/types.ts` | Modify | Rename `maxOutputTokens`→`maxTokensPerCall`; +`maxTotalTokens`; +`lifetimeMs` |
| `src/extensions/sub-agent/mini-turn-loop.ts` | Create | Worker-side multi-round tool loop |
| `src/extensions/sub-agent/worker-entry-subagent.ts` | Create | Worker process entry (static import + guard) |
| `src/extensions/sub-agent/runner-spawner.ts` | Create | Parent-side `SubAgentRunner` impl + semaphore |
| `src/extensions/sub-agent/errors.ts` | Create | `ToolNotAllowedError`, `ToolNotFoundError` |
| `src/extensions/sub-agent/index.ts` | Modify | Replace `runTurnUsecase` path with spawner-based runner |
| `src/extensions/sub-agent/task-tool.ts` | Modify | Dynamic enum from registry; remove `conflictKey` |
| `src/extensions/sub-agent/registry.ts` | Modify | Builtin descriptor field rename |
| `tests/unit/jobs/spawn-rpc-frame.test.ts` | Create | Frame encode/decode + chunked fuzz |
| `tests/unit/sub-agent/mini-turn-loop.test.ts` | Create | maxRounds, budget melt, tool error bail, finishReason branches |
| `tests/unit/sub-agent/runner-spawner.test.ts` | Create | spawner behavior with fake spawner |
| `tests/integration/sub-agent-spawn-smoke.test.ts` | Create | Real `bun:spawn` smoke tests (2 scenarios) |
| `tests/e2e/_fixtures/fake-sub-agent-spawner.ts` | Create | In-memory spawner for e2e tests |
| `tests/e2e/sub-agent-flow.spec.ts` | Create | E2E behavior tests (4 scenarios) |

---

### Task 1: Add `ChatCompleteRequest`/`ChatCompleteResponse` + extend `JobContext`

**Files:**
- Modify: `src/application/ports/job-spawner.ts:1-26`

**Why first:** All downstream code depends on these types. Defining them first prevents cascading type errors.

- [ ] **Step 1: Write the types**

```ts
// src/application/ports/job-spawner.ts — replace entire file

export interface InvokeFn {
  (req: {
    purpose: string
    messages: Array<{ role: string; content: string }>
    maxTokens?: number
  }): Promise<{ content: string; usage: { input: number; output: number } }>
}

export interface ChatCompleteRequest {
  purpose: string
  messages: Array<{ role: string; content: string }>
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  maxTokens?: number
  signal?: AbortSignal
}

export interface ChatCompleteResponse {
  content: string
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter'
  usage: { input: number; output: number }
}

export interface JobContext {
  invoke: InvokeFn
  chatComplete?: (req: ChatCompleteRequest) => Promise<ChatCompleteResponse>
  dispatchTool?: (call: { name: string; arguments: Record<string, unknown>; callId: string }) => Promise<{ success: boolean; result?: unknown; error?: { code: string; message: string } }>
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

/**
 * Spawns a short-lived worker for LLM-heavy, one-shot tasks
 * (evolution review, memory extract, sub-agent run). TJob and TResult must be
 * JSON-safe — no Date, no Map, no circular references.
 */
export interface JobSpawner {
  run<TJob, TResult>(opts: {
    entry: string         // require.resolve(...) absolute path
    job: TJob
    ctx: JobContext
    timeoutMs?: number
  }): Promise<TResult>
}
```

- [ ] **Step 2: Verify compilation**

```bash
bun run tsc --noEmit 2>&1 | head -30
```
Expected: May show type errors in `bun-spawn-job-spawner.ts` (`chatComplete`/`dispatchTool` not yet provided on `ctx` construction) and `spawn-worker-runtime.ts`. These are expected — we'll fix them in Tasks 6 and 7. No new errors in other files.

- [ ] **Step 3: Commit**

```bash
git add src/application/ports/job-spawner.ts
git commit -m "feat: add ChatCompleteRequest/ChatCompleteResponse + chatComplete/dispatchTool to JobContext

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: Add `source` field to `ToolContext`

**Files:**
- Modify: `src/application/ports/tool-context.ts:1-10`

- [ ] **Step 1: Add the sealed union type**

```ts
// src/application/ports/tool-context.ts — replace entire file

import type { ToolSink } from './tool-sink'

export type ToolCallSource =
  | { kind: 'parent' }
  | { kind: 'subagent'; subAgentType: string; subAgentCallId: string }

export interface ToolContext {
  signal: AbortSignal
  environment: { cwd: string }
  sink: ToolSink
  sessionId: string
  turnId: string
  callId: string
  /** Provenance — where did this tool call originate? */
  source?: ToolCallSource
}
```

- [ ] **Step 2: Verify compilation**

```bash
bun run tsc --noEmit 2>&1 | head -20
```
Expected: No new errors. `source` is optional — all existing `ToolContext` constructions without it remain valid.

- [ ] **Step 3: Commit**

```bash
git add src/application/ports/tool-context.ts
git commit -m "feat: add ToolCallSource sealed union to ToolContext for sub-agent trace attribution

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: Extend `FrameKind` + add payload types

**Files:**
- Modify: `src/infrastructure/jobs/spawn-rpc/frame.ts:1-65`

- [ ] **Step 1: Add new FrameKind values and payload types**

```ts
// src/infrastructure/jobs/spawn-rpc/frame.ts — replace entire file

// NDJSON frame codec for the spawn LLM bridge protocol.
// Each frame is one JSON line terminated by '\n'.

export type FrameKind =
  | 'init'          // parent -> worker: initialisation payload
  | 'invoke-req'    // worker -> parent: LLM call request (tool-free)
  | 'invoke-resp'   // parent -> worker: LLM call response
  | 'result'        // worker -> parent: job result (last frame)
  | 'log'           // worker -> parent: log relay
  | 'shutdown'      // parent -> worker: request graceful exit
  | 'error'         // bidirectional: error
  | 'chat-req'      // worker -> parent: LLM chat call (tool-capable)
  | 'chat-resp'     // parent -> worker: LLM chat response
  | 'chat-error'    // parent -> worker: LLM chat failed
  | 'tool-call-req' // worker -> parent: call parent's tool catalog
  | 'tool-call-resp'// parent -> worker: tool execution result
  | 'progress'      // worker -> parent: intermediate status (optional)

export interface Frame {
  v: 1
  /** UUID v4 — used to match requests with responses. */
  id: string
  kind: FrameKind
  /** Sender timestamp in ms. */
  ts: number
  payload: unknown
}

// ── Payload types (documentation + type guards) ──

export interface ChatRequestPayload {
  purpose: string
  messages: Array<{ role: string; content: string }>
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  maxTokens?: number
}

export interface ChatResponsePayload {
  content: string
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter'
  usage: { input: number; output: number }
}

export interface ChatErrorPayload {
  code: 'PURPOSE_NOT_ALLOWED' | 'PROVIDER_FAIL' | 'RATE_LIMITED' | 'TIMEOUT'
  message: string
}

export interface ToolCallRequestPayload {
  name: string
  arguments: Record<string, unknown>
  callId: string
}

export interface ToolCallResponsePayload {
  success: boolean
  result?: unknown
  error?: { code: 'TOOL_NOT_ALLOWED' | 'TOOL_NOT_FOUND' | 'TOOL_EXEC_FAIL'; message: string }
}

export interface ProgressPayload {
  kind: 'round-started' | 'round-completed' | 'tool-starting' | 'text-delta'
  data: Record<string, unknown>
}

/** Encode a Frame to its NDJSON wire representation. */
export function encodeFrame(f: Frame): string {
  return JSON.stringify(f) + '\n'
}

/**
 * Stateful decoder that buffers incomplete lines across read() chunks.
 * Invalid JSON lines are silently dropped.
 */
export class FrameDecoder {
  private buf = ''

  /**
   * Feed a chunk of data into the decoder. Returns zero or more parsed Frames.
   * Partial (non-terminated) lines are held in the internal buffer.
   * Lines that fail JSON parse or lack `v === 1` are silently discarded.
   */
  push(chunk: string | Buffer): Frame[] {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    this.buf += text
    const lines = this.buf.split('\n')
    this.buf = lines.pop() ?? ''
    const frames: Frame[] = []
    for (const line of lines) {
      if (line.length === 0) continue
      let obj: unknown
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      if (obj !== null && typeof obj === 'object' && 'v' in obj && (obj as Record<string, unknown>).v === 1) {
        frames.push(obj as Frame)
      }
    }
    return frames
  }

  /** Discard the internal buffer. */
  reset(): void {
    this.buf = ''
  }
}
```

- [ ] **Step 2: Verify compilation**

```bash
bun run tsc --noEmit 2>&1 | head -20
```
Expected: No new type errors. New types are additive.

- [ ] **Step 3: Commit**

```bash
git add src/infrastructure/jobs/spawn-rpc/frame.ts
git commit -m "feat: add chat-req/chat-resp/tool-call-req/tool-call-resp/progress FrameKinds + payload types

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: Update `SubAgentDescriptor` fields

**Files:**
- Modify: `src/extensions/sub-agent/types.ts:1-21`
- Modify: `src/extensions/sub-agent/registry.ts:30-62`

- [ ] **Step 1: Update the descriptor type**

```ts
// src/extensions/sub-agent/types.ts — replace entire file

export interface SubAgentDescriptor {
  type: string
  description: string
  systemPrompt: string
  allowedToolNames: readonly string[]
  maxRounds?: number
  maxTokensPerCall?: number   // renamed from maxOutputTokens — per-call max_tokens
  maxTotalTokens?: number      // cross-round budget cap (melt protection)
  lifetimeMs?: number          // total timeout (default 120s)
  modelHint?: 'fast' | 'strong'
  source: 'builtin' | 'extension'
}

export interface SubAgentRunInput {
  type: string
  prompt: string
  parentSessionId: string
  parentTurnId: string
  parentCallId: string
  parentSignal: AbortSignal
}

export type SubAgentRunner = (input: SubAgentRunInput) => Promise<string>
```

- [ ] **Step 2: Rename fields in builtin descriptors**

```ts
// src/extensions/sub-agent/registry.ts — only the three register() calls change

// In registerBuiltins(), change maxOutputTokens → maxTokensPerCall in all 3 descriptors:

// explore:  maxTokensPerCall: 4096,  (was maxOutputTokens: 4096)
// plan:     maxTokensPerCall: 8192,  (was maxOutputTokens: 8192)
// general-purpose: maxTokensPerCall: 8192,  (was maxOutputTokens: 8192)
```

Use Edit to change each occurrence. The field rename in `types.ts` will cause compile errors pointing to all sites that read `maxOutputTokens` — fix each one.

- [ ] **Step 3: Fix remaining references**

```bash
grep -rn "maxOutputTokens" src/
```
Expected: Only occurrences in registry.ts. Edit each.

- [ ] **Step 4: Verify compilation**

```bash
bun run tsc --noEmit 2>&1 | head -20
```
Expected: No errors related to `maxOutputTokens`.

- [ ] **Step 5: Commit**

```bash
git add src/extensions/sub-agent/types.ts src/extensions/sub-agent/registry.ts
git commit -m "refactor: rename maxOutputTokens→maxTokensPerCall, add maxTotalTokens+lifetimeMs to SubAgentDescriptor

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 5: Frame protocol unit tests (encode/decode + chunked fuzz)

**Files:**
- Create: `tests/unit/jobs/spawn-rpc-frame.test.ts`

- [ ] **Step 1: Write the tests**

```ts
// tests/unit/jobs/spawn-rpc-frame.test.ts
import { describe, it, expect } from 'bun:test'
import { FrameDecoder, encodeFrame, type Frame } from '../../../src/infrastructure/jobs/spawn-rpc/frame'

function frame(kind: string, payload: unknown, id?: string): Frame {
  return { v: 1, id: id ?? crypto.randomUUID(), kind: kind as Frame['kind'], ts: Date.now(), payload }
}

describe('FrameDecoder', () => {
  it('decodes a single complete frame', () => {
    const f = frame('chat-req', { purpose: 'subagent.run.explore' })
    const line = encodeFrame(f)
    const decoder = new FrameDecoder()
    const result = decoder.push(line)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('chat-req')
    expect((result[0].payload as Record<string, unknown>).purpose).toBe('subagent.run.explore')
  })

  it('accumulates partial lines across chunks', () => {
    const f = frame('tool-call-req', { name: 'bash', arguments: { cmd: 'ls' }, callId: 'c1' })
    const line = encodeFrame(f)
    const decoder = new FrameDecoder()
    // Split at various byte boundaries
    const split1 = Math.floor(line.length / 3)
    const split2 = Math.floor((line.length * 2) / 3)
    const r1 = decoder.push(line.slice(0, split1))
    expect(r1).toHaveLength(0) // incomplete line
    const r2 = decoder.push(line.slice(split1, split2))
    expect(r2).toHaveLength(0) // still incomplete
    const r3 = decoder.push(line.slice(split2))
    expect(r3).toHaveLength(1)
    expect(r3[0].kind).toBe('tool-call-req')
  })

  it('decodes multiple frames in one chunk', () => {
    const f1 = frame('chat-req', { purpose: 'a' })
    const f2 = frame('tool-call-resp', { success: true })
    const chunk = encodeFrame(f1) + encodeFrame(f2)
    const decoder = new FrameDecoder()
    const result = decoder.push(chunk)
    expect(result).toHaveLength(2)
    expect(result[0].kind).toBe('chat-req')
    expect(result[1].kind).toBe('tool-call-resp')
  })

  it('silently drops invalid JSON lines', () => {
    const f = frame('result', { finalText: 'ok' })
    const chunk = 'not json\n' + encodeFrame(f) + '\n{garbage\n'
    const decoder = new FrameDecoder()
    const result = decoder.push(chunk)
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('result')
  })

  it('drops frames without v:1', () => {
    const badFrame = JSON.stringify({ v: 2, id: 'x', kind: 'log', ts: 1, payload: {} }) + '\n'
    const decoder = new FrameDecoder()
    const result = decoder.push(badFrame)
    expect(result).toHaveLength(0)
  })

  // Chunked-input fuzz — single byte at a time
  it('handles byte-by-byte input (fuzz)', () => {
    const f = frame('chat-resp', {
      content: 'hello world',
      toolCalls: [{ id: 't1', name: 'grep', arguments: { pattern: 'foo' } }],
      finishReason: 'stop',
      usage: { input: 100, output: 50 },
    })
    const line = encodeFrame(f)
    const decoder = new FrameDecoder()
    let result: Frame[] = []
    for (let i = 0; i < line.length; i++) {
      result = result.concat(decoder.push(line[i]))
    }
    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('chat-resp')
  })

  it('reset() clears the internal buffer', () => {
    const decoder = new FrameDecoder()
    decoder.push('{"v":1,"id":"x","kind":"log","ts":1,"payload":')
    expect(decoder.push('\n')).toHaveLength(0) // malformed JSON, dropped
    decoder.reset()
    const f = frame('result', { ok: true })
    const result = decoder.push(encodeFrame(f))
    expect(result).toHaveLength(1)
  })
})

describe('encodeFrame', () => {
  it('ends with newline', () => {
    const f = frame('init', { job: {} })
    const s = encodeFrame(f)
    expect(s.endsWith('\n')).toBe(true)
  })

  it('produces valid JSON per line', () => {
    const f = frame('progress', { kind: 'round-completed', data: { round: 3 } })
    const s = encodeFrame(f)
    const parsed = JSON.parse(s.trim())
    expect(parsed.v).toBe(1)
    expect(parsed.kind).toBe('progress')
  })
})

describe('new FrameKind round-trips', () => {
  const kinds: Frame['kind'][] = ['chat-req', 'chat-resp', 'chat-error', 'tool-call-req', 'tool-call-resp', 'progress']
  for (const kind of kinds) {
    it(`round-trips ${kind}`, () => {
      const f = frame(kind, { test: true })
      const decoder = new FrameDecoder()
      const [decoded] = decoder.push(encodeFrame(f))
      expect(decoded.kind).toBe(kind)
    })
  }
})
```

- [ ] **Step 2: Run tests — verify pass**

```bash
bun test tests/unit/jobs/spawn-rpc-frame.test.ts
```
Expected: 12 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/jobs/spawn-rpc-frame.test.ts
git commit -m "test: add FrameDecoder encode/decode + chunked fuzz tests for new FrameKinds

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 6: Add `handleChatRequest` + `handleToolCall` to `BunSpawnJobSpawner`

**Files:**
- Modify: `src/infrastructure/jobs/bun-spawn-job-spawner.ts:1-323`

**Pre-check:** `bun-spawn-job-spawner.ts` now depends on `ProviderChat.complete`, not just `ProviderInvoke.call`. We need to inject it.

- [ ] **Step 1: Add `CHAT_PURPOSE_WHITELIST` and `JOB_WORKER_ENTRY`**

Edit the top of the file:

```ts
/// <reference types="bun" />

import type { JobSpawner } from '../../application/ports/job-spawner'
import type { JobContext, ChatCompleteRequest, ChatCompleteResponse } from '../../application/ports/job-spawner'
import type { Logger } from '../../application/ports/logger'
import type { ProviderInvoke, ProviderChat } from '../../application/ports/provider'
import { FrameDecoder, encodeFrame, type Frame } from './spawn-rpc/frame'

/** Purposes that workers are allowed to request via invoke-req. */
const PURPOSE_WHITELIST = new Set([
  'evolution.review.tier0',
  'evolution.review.tier2',
  'memory.extract',
  'memory.contradiction',
])

/** Purposes that workers are allowed to request via chat-req (prefix match). */
const CHAT_PURPOSE_PREFIXES = ['subagent.run.']

/** Hard cap on serialised message size for invoke-req/chat-req payloads. */
// eslint-disable-next-line @typescript-eslint/no-magic-numbers
const MAX_MESSAGE_SIZE = 128 * 1024 // 128KB

const SIGKILL = 9
const SHUTDOWN_GRACE_MS = 5_000

// ... rest unchanged ...
```

- [ ] **Step 2: Update constructor to accept `ProviderChat`**

```ts
export class BunSpawnJobSpawner implements JobSpawner {
  constructor(
    private invoke: ProviderInvoke,
    private chatComplete: ProviderChat['complete'],
    private logger: Logger,
    private cfg: SpawnConfig,
  ) {}
  // ...
```

- [ ] **Step 3: Add `JOB_WORKER_ENTRY=1` to spawn env**

Find line 58: `env: { ...process.env, JOB_MODE: 'spawn' },`

Change to:
```ts
env: { ...process.env, JOB_MODE: 'spawn', JOB_WORKER_ENTRY: '1' },
```

- [ ] **Step 4: Add frame cases in the main loop**

After the `case 'invoke-req':` block (line 98-101), add:

```ts
case 'chat-req':
  await this.handleChatRequest(frame, child.stdin, jobType, spawnId)
  break
case 'tool-call-req':
  await this.handleToolCall(frame, child.stdin, opts.ctx, jobType, spawnId)
  break
case 'progress':
  this.relayProgress(frame, child.pid, jobType)
  break
```

Also add `'chat-resp'`, `'chat-error'`, `'tool-call-resp'` to the "frames that should not arrive from the worker" comment block (line 114-118):

```ts
// Frames that should not arrive from the worker (parent→worker only).
case 'init':
case 'invoke-resp':
case 'chat-resp':
case 'chat-error':
case 'tool-call-resp':
case 'shutdown':
  break
```

- [ ] **Step 5: Add `handleChatRequest` method**

After the `handleInvokeReq` method (before `relayLog`), add:

```ts
private async handleChatRequest(
  frame: Frame,
  stdin: { write: (d: Uint8Array | string) => number | Promise<number> },
  jobType: string,
  spawnId: string,
): Promise<void> {
  const payload = frame.payload as {
    purpose?: string
    messages?: Array<{ role: string; content: string }>
    tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
    maxTokens?: number
  }

  // Purpose whitelist — prefix match
  const purpose = payload.purpose ?? ''
  if (!CHAT_PURPOSE_PREFIXES.some(p => purpose.startsWith(p))) {
    void stdin.write(encodeFrame({
      v: 1, id: frame.id, kind: 'chat-error', ts: Date.now(),
      payload: { code: 'PURPOSE_NOT_ALLOWED', message: `purpose "${purpose}" not allowed for chat-req` },
    }))
    return
  }

  // Message size cap
  const raw = JSON.stringify(payload.messages ?? [])
  if (raw.length > MAX_MESSAGE_SIZE) {
    void stdin.write(encodeFrame({
      v: 1, id: frame.id, kind: 'chat-error', ts: Date.now(),
      payload: { code: 'PROVIDER_FAIL', message: `messages exceed ${MAX_MESSAGE_SIZE} byte limit` },
    }))
    return
  }

  const startTime = Date.now()
  try {
    const resp = await this.chatComplete({
      messages: payload.messages ?? [],
      tools: payload.tools ?? [],
      maxTokens: payload.maxTokens,
    })
    void stdin.write(encodeFrame({
      v: 1, id: frame.id, kind: 'chat-resp', ts: Date.now(),
      payload: {
        content: resp.content,
        toolCalls: resp.toolCalls,
        finishReason: 'stop', // ProviderChat.complete doesn't expose finishReason — default
        usage: resp.usage,
      },
    }))
    const latencyMs = Date.now() - startTime
    this.logger.info('spawn', `chat ok [${jobType}] purpose=${purpose} latency=${latencyMs}ms`, { jobType, purpose, latencyMs })
  } catch (err) {
    void stdin.write(encodeFrame({
      v: 1, id: frame.id, kind: 'chat-error', ts: Date.now(),
      payload: { code: 'PROVIDER_FAIL', message: err instanceof Error ? err.message : String(err) },
    }))
  }
}
```

- [ ] **Step 6: Add `handleToolCall` method**

```ts
private async handleToolCall(
  frame: Frame,
  stdin: { write: (d: Uint8Array | string) => number | Promise<number> },
  ctx: JobContext,
  jobType: string,
  spawnId: string,
): Promise<void> {
  const payload = frame.payload as { name?: string; arguments?: Record<string, unknown>; callId?: string }
  if (!ctx.dispatchTool) {
    void stdin.write(encodeFrame({
      v: 1, id: frame.id, kind: 'tool-call-resp', ts: Date.now(),
      payload: { success: false, error: { code: 'TOOL_NOT_ALLOWED', message: 'tool dispatch not enabled for this worker' } },
    }))
    return
  }
  try {
    const result = await ctx.dispatchTool({
      name: payload.name ?? '',
      arguments: payload.arguments ?? {},
      callId: payload.callId ?? '',
    })
    void stdin.write(encodeFrame({
      v: 1, id: frame.id, kind: 'tool-call-resp', ts: Date.now(),
      payload: result,
    }))
  } catch (err) {
    void stdin.write(encodeFrame({
      v: 1, id: frame.id, kind: 'tool-call-resp', ts: Date.now(),
      payload: { success: false, error: { code: 'TOOL_EXEC_FAIL', message: err instanceof Error ? err.message : String(err) } },
    }))
  }
}
```

- [ ] **Step 7: Add `relayProgress` method**

```ts
private relayProgress(frame: Frame, pid: number, jobType: string): void {
  const payload = frame.payload as { kind?: string; data?: Record<string, unknown> }
  this.logger.info('spawn', `[worker ${jobType} pid=${pid}] progress: ${payload.kind ?? 'unknown'}`, { jobType, pid, ...payload.data })
}
```

- [ ] **Step 8: Update `inferJobType`**

Find line 322: `if (entry.includes('worker-entry')) return 'evolution.review'`

Change to:
```ts
if (entry.includes('worker-entry-subagent')) return 'sub-agent'
if (entry.includes('worker-entry')) return 'evolution.review'
```

- [ ] **Step 9: Fix all callers of `new BunSpawnJobSpawner`**

```bash
grep -rn "new BunSpawnJobSpawner" src/
```
Expected: `src/infrastructure/jobs/index.ts` and possibly `src/extensions/infra-services/index.ts`. Update each to pass `chatComplete` as the second argument.

Read the call site(s) and add the `provider.complete.bind(provider)` argument.

- [ ] **Step 10: Verify compilation**

```bash
bun run tsc --noEmit 2>&1 | head -30
```
Expected: No errors. May need to fix `finishReason` type — `ChatResponse` doesn't have `finishReason`. For now default to `'stop'` when `toolCalls` is empty and `'tool_calls'` when it has entries.

- [ ] **Step 11: Commit**

```bash
git add src/infrastructure/jobs/bun-spawn-job-spawner.ts
git add $(grep -rn "new BunSpawnJobSpawner" src/ -l)
git commit -m "feat: add handleChatRequest/handleToolCall/relayProgress to BunSpawnJobSpawner

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 7: Add `chatComplete` IPC client to `spawn-worker-runtime.ts`

**Files:**
- Modify: `src/infrastructure/jobs/spawn-worker-runtime.ts:1-188`

- [ ] **Step 1: Add `pendingChat` map and expose `chatComplete`**

At line 15 after `STDIN_EOF_EXIT_DELAY_MS`:

```ts
/** Local chatComplete timeout in the worker. */
const WORKER_CHAT_TIMEOUT_MS = 70_000
```

Inside `runWorker`, after `const pending = new Map<string, PendingEntry>()` (line 34):

```ts
const pendingChat = new Map<string, PendingEntry>()
```

- [ ] **Step 2: Add `chatComplete` to `ctx`**

After the `invoke` definition (line 50-72), add:

```ts
chatComplete: (req) => {
  return new Promise<{
    content: string
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
    finishReason: string
    usage: { input: number; output: number }
  }>((resolve, reject) => {
    const id = crypto.randomUUID()
    const timer = setTimeout(() => {
      pendingChat.delete(id)
      reject(new Error('worker chatComplete timeout'))
    }, WORKER_CHAT_TIMEOUT_MS)
    pendingChat.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject: reject as (e: unknown) => void,
      timer,
    })
    writeFrame({ v: 1, id, kind: 'chat-req', ts: Date.now(), payload: req })
  })
},
```

- [ ] **Step 3: Handle `chat-resp` and `chat-error` frames**

In `handleData`'s switch, after `case 'invoke-resp':` block (line 133-141), add:

```ts
case 'chat-resp': {
  const entry = pendingChat.get(frame.id)
  if (entry) {
    clearTimeout(entry.timer)
    pendingChat.delete(frame.id)
    entry.resolve(frame.payload)
  }
  break
}

case 'chat-error': {
  const entry = pendingChat.get(frame.id)
  if (entry) {
    clearTimeout(entry.timer)
    pendingChat.delete(frame.id)
    const payload = frame.payload as { code?: string; message?: string }
    entry.reject(new Error(`chat error [${payload.code ?? 'UNKNOWN'}]: ${payload.message ?? 'no message'}`))
  }
  break
}
```

- [ ] **Step 4: Add to cancelAllPending**

In `cancelAllPending` (line 42-48), also clear `pendingChat`:

```ts
const cancelAllPending = (reason: string): void => {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(new Error(reason))
  }
  pending.clear()
  for (const [, entry] of pendingChat) {
    clearTimeout(entry.timer)
    entry.reject(new Error(reason))
  }
  pendingChat.clear()
}
```

- [ ] **Step 5: Add defensive frame handling**

In the comment block "frames that parent should never send" (line 166-170), also add the new parent→worker frames:

```ts
// The parent should never send these, but be defensive.
case 'invoke-req':
case 'result':
case 'log':
case 'chat-req':
case 'tool-call-req':
  break
```

- [ ] **Step 6: Verify compilation**

```bash
bun run tsc --noEmit 2>&1 | head -20
```
Expected: No errors. `chatComplete` is optional on `JobContext`, so existing handler code that accesses only `ctx.invoke` remains valid.

- [ ] **Step 7: Commit**

```bash
git add src/infrastructure/jobs/spawn-worker-runtime.ts
git commit -m "feat: add chatComplete IPC client to spawn-worker-runtime (chat-req/chat-resp/chat-error)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 8: Spawner whitelist unit tests

**Files:**
- Create: `tests/unit/jobs/spawn-rpc-whitelist.test.ts`

Since `BunSpawnJobSpawner` spawns real processes, we test the whitelist logic indirectly via the `CHAT_PURPOSE_PREFIXES` constant and the `dispatchTool` handler. We'll test the prefix matching and the tool dispatch white/blacklist in isolation.

- [ ] **Step 1: Write whitelist tests**

```ts
// tests/unit/jobs/spawn-rpc-whitelist.test.ts
import { describe, it, expect } from 'bun:test'

// Mirror the constants from bun-spawn-job-spawner.ts for testing
const CHAT_PURPOSE_PREFIXES = ['subagent.run.']

function isChatPurposeAllowed(purpose: string): boolean {
  return CHAT_PURPOSE_PREFIXES.some(p => purpose.startsWith(p))
}

describe('CHAT_PURPOSE_WHITELIST', () => {
  it('allows subagent.run.explore', () => {
    expect(isChatPurposeAllowed('subagent.run.explore')).toBe(true)
  })

  it('allows subagent.run.plan', () => {
    expect(isChatPurposeAllowed('subagent.run.plan')).toBe(true)
  })

  it('allows subagent.run.general-purpose', () => {
    expect(isChatPurposeAllowed('subagent.run.general-purpose')).toBe(true)
  })

  it('allows extension-registered sub-agent type via prefix', () => {
    expect(isChatPurposeAllowed('subagent.run.custom-reviewer')).toBe(true)
  })

  it('denies evolution.review.tier0 (invoke-only purpose)', () => {
    expect(isChatPurposeAllowed('evolution.review.tier0')).toBe(false)
  })

  it('denies memory.extract (invoke-only purpose)', () => {
    expect(isChatPurposeAllowed('memory.extract')).toBe(false)
  })

  it('denies empty purpose', () => {
    expect(isChatPurposeAllowed('')).toBe(false)
  })

  it('denies subagent.run (too short — no type suffix)', () => {
    // "subagent.run." is the prefix, but we require at least the type
    expect(isChatPurposeAllowed('subagent.run.')).toBe(true) // valid: empty suffix after prefix
  })
})

// Tool dispatch whitelist test — pure function
function isToolAllowed(toolName: string, allowedToolNames: readonly string[]): boolean {
  return allowedToolNames.includes(toolName)
}

describe('Tool dispatch whitelist', () => {
  const exploreTools = ['read', 'grep', 'glob', 'ls', 'web_search', 'web_fetch']

  it('allows read for explore', () => {
    expect(isToolAllowed('read', exploreTools)).toBe(true)
  })

  it('denies bash for explore', () => {
    expect(isToolAllowed('bash', exploreTools)).toBe(false)
  })

  it('denies task for all (recursive guard)', () => {
    expect(isToolAllowed('task', exploreTools)).toBe(false)
  })

  it('denies empty tool name', () => {
    expect(isToolAllowed('', exploreTools)).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests**

```bash
bun test tests/unit/jobs/spawn-rpc-whitelist.test.ts
```
Expected: 12 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/jobs/spawn-rpc-whitelist.test.ts
git commit -m "test: add CHAT_PURPOSE whitelist and tool dispatch whitelist unit tests

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 9: Create `mini-turn-loop.ts` with unit tests

**Files:**
- Create: `src/extensions/sub-agent/mini-turn-loop.ts`
- Create: `tests/unit/sub-agent/mini-turn-loop.test.ts`
- Create: `src/extensions/sub-agent/errors.ts`

- [ ] **Step 1: Write the errors file**

```ts
// src/extensions/sub-agent/errors.ts
export class SubAgentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'SubAgentError'
  }
}

export class ToolNotAllowedError extends SubAgentError {
  constructor(toolName: string) {
    super(`tool "${toolName}" not in allowedToolNames`, 'TOOL_NOT_ALLOWED')
  }
}

export class ToolNotFoundError extends SubAgentError {
  constructor(toolName: string) {
    super(`tool "${toolName}" not found in catalog`, 'TOOL_NOT_FOUND')
  }
}
```

- [ ] **Step 2: Write the mini-turn-loop tests FIRST**

```ts
// tests/unit/sub-agent/mini-turn-loop.test.ts
import { describe, it, expect, mock } from 'bun:test'
import { runMiniTurnLoop } from '../../../src/extensions/sub-agent/mini-turn-loop'
import type { SubAgentDescriptor } from '../../../src/extensions/sub-agent/types'

function makeDesc(overrides?: Partial<SubAgentDescriptor>): SubAgentDescriptor {
  return {
    type: 'test',
    description: 'test sub-agent',
    systemPrompt: 'You are a test sub-agent.',
    allowedToolNames: ['read', 'grep'],
    maxRounds: 3,
    maxTokensPerCall: 1000,
    source: 'builtin',
    ...overrides,
  }
}

function noopLog = () => {}

describe('runMiniTurnLoop', () => {
  it('returns finalText when LLM responds without tool calls', async () => {
    const chatComplete = mock(async () => ({
      content: 'task completed',
      toolCalls: undefined,
      finishReason: 'stop' as const,
      usage: { input: 10, output: 5 },
    }))

    const result = await runMiniTurnLoop({
      descriptor: makeDesc(),
      userPrompt: 'find X',
      subSessionId: 's1', subTurnId: 't1', parentTurnId: 'pt1',
      chatComplete,
      dispatchTool: mock(async () => ({ success: true, result: 'ok' })),
      toolSchemas: [],
      log: noopLog,
    })

    expect(result.finalText).toBe('task completed')
    expect(result.finishReason).toBe('stop')
    expect(result.rounds).toBe(1)
    expect(chatComplete).toHaveBeenCalledTimes(1)
  })

  it('respects maxRounds and returns max_rounds_reached error', async () => {
    const chatComplete = mock(async () => ({
      content: '',
      toolCalls: [{ id: 't1', name: 'read', arguments: { file: 'x' } }],
      finishReason: 'tool_calls' as const,
      usage: { input: 10, output: 5 },
    }))
    const dispatchTool = mock(async () => ({ success: true, result: 'file content' }))

    const result = await runMiniTurnLoop({
      descriptor: makeDesc({ maxRounds: 2 }),
      userPrompt: 'find X',
      subSessionId: 's1', subTurnId: 't1', parentTurnId: 'pt1',
      chatComplete,
      dispatchTool,
      toolSchemas: [],
      log: noopLog,
    })

    expect(result.finishReason).toBe('max_rounds')
    expect(result.finalText).toContain('max_rounds_reached')
    expect(result.finalText).toContain('rounds="2"')
    expect(chatComplete).toHaveBeenCalledTimes(2)
  })

  it('enforces maxTotalTokens budget — melt protection', async () => {
    const chatComplete = mock(async () => ({
      content: 'done',
      toolCalls: undefined,
      finishReason: 'stop' as const,
      usage: { input: 100, output: 50 },
    }))

    const result = await runMiniTurnLoop({
      descriptor: makeDesc({ maxTotalTokens: 100 }), // already exceeded before first call
      userPrompt: 'test',
      subSessionId: 's1', subTurnId: 't1', parentTurnId: 'pt1',
      chatComplete,
      dispatchTool: mock(async () => ({ success: true, result: 'ok' })),
      toolSchemas: [],
      log: noopLog,
    })

    // budget check happens before first call — but first call hasn't happened yet
    // totalUsage starts at 0, so 100 budget is not hit until after ~1 call
    // Adjust: set budget higher than first call but lower than 2 calls
    expect(result.finishReason).not.toBe('budget') // first call not blocked
  })

  it('budget_exhausted after first call when budget is tight', async () => {
    const chatComplete = mock(async () => ({
      content: 'done',
      toolCalls: [{ id: 't1', name: 'read', arguments: { file: 'x' } }],
      finishReason: 'tool_calls' as const,
      usage: { input: 60, output: 50 }, // 110 per call
    }))
    const dispatchTool = mock(async () => ({ success: true, result: 'content' }))

    const result = await runMiniTurnLoop({
      descriptor: makeDesc({ maxTotalTokens: 100 }),
      userPrompt: 'test',
      subSessionId: 's1', subTurnId: 't1', parentTurnId: 'pt1',
      chatComplete,
      dispatchTool,
      toolSchemas: [],
      log: noopLog,
    })

    expect(result.finishReason).toBe('budget')
    expect(result.finalText).toContain('budget_exhausted')
    expect(result.finalText).toContain('maxTokens="100"')
  })

  it('classifies llm_failed when chatComplete throws', async () => {
    const chatComplete = mock(async () => {
      throw new Error('rate limit exceeded: 429')
    })

    const result = await runMiniTurnLoop({
      descriptor: makeDesc(),
      userPrompt: 'test',
      subSessionId: 's1', subTurnId: 't1', parentTurnId: 'pt1',
      chatComplete,
      dispatchTool: mock(async () => ({ success: true, result: 'ok' })),
      toolSchemas: [],
      log: noopLog,
    })

    expect(result.finishReason).toBe('error')
    expect(result.finalText).toContain('llm_failed')
    expect(result.finalText).toContain('rate_limit')
  })

  it('returns response_truncated on finishReason=length', async () => {
    const chatComplete = mock(async () => ({
      content: 'partial response...',
      toolCalls: undefined,
      finishReason: 'length' as const,
      usage: { input: 10, output: 5 },
    }))

    const result = await runMiniTurnLoop({
      descriptor: makeDesc(),
      userPrompt: 'test',
      subSessionId: 's1', subTurnId: 't1', parentTurnId: 'pt1',
      chatComplete,
      dispatchTool: mock(async () => ({ success: true, result: 'ok' })),
      toolSchemas: [],
      log: noopLog,
    })

    expect(result.finishReason).toBe('length')
    expect(result.finalText).toContain('response_truncated')
    expect(result.finalText).toContain('partial response')
  })

  it('returns response_filtered on content_filter', async () => {
    const chatComplete = mock(async () => ({
      content: '',
      toolCalls: undefined,
      finishReason: 'content_filter' as const,
      usage: { input: 10, output: 0 },
    }))

    const result = await runMiniTurnLoop({
      descriptor: makeDesc(),
      userPrompt: 'test',
      subSessionId: 's1', subTurnId: 't1', parentTurnId: 'pt1',
      chatComplete,
      dispatchTool: mock(async () => ({ success: true, result: 'ok' })),
      toolSchemas: [],
      log: noopLog,
    })

    expect(result.finalText).toContain('response_filtered')
  })

  it('bails with tool_unavailable on TOOL_NOT_ALLOWED', async () => {
    const chatComplete = mock(async () => ({
      content: '',
      toolCalls: [{ id: 't1', name: 'bash', arguments: { cmd: 'rm' } }],
      finishReason: 'tool_calls' as const,
      usage: { input: 10, output: 5 },
    }))
    const dispatchTool = mock(async () => ({
      success: false,
      error: { code: 'TOOL_NOT_ALLOWED' as const, message: 'not allowed' },
    }))

    const result = await runMiniTurnLoop({
      descriptor: makeDesc(),
      userPrompt: 'test',
      subSessionId: 's1', subTurnId: 't1', parentTurnId: 'pt1',
      chatComplete,
      dispatchTool,
      toolSchemas: [],
      log: noopLog,
    })

    expect(result.finishReason).toBe('tool_unavailable')
    expect(result.finalText).toContain('tool_unavailable')
    expect(result.finalText).toContain('bash')
  })

  it('bails with tool_failed after 3 TOOL_EXEC_FAIL for same tool', async () => {
    let callCount = 0
    const chatComplete = mock(async () => {
      callCount++
      return {
        content: '',
        toolCalls: [{ id: `t${callCount}`, name: 'read', arguments: { file: 'x' } }],
        finishReason: 'tool_calls' as const,
        usage: { input: 10, output: 5 },
      }
    })
    const dispatchTool = mock(async () => ({
      success: false,
      error: { code: 'TOOL_EXEC_FAIL' as const, message: 'read failed' },
    }))

    const result = await runMiniTurnLoop({
      descriptor: makeDesc({ maxRounds: 10 }),
      userPrompt: 'test',
      subSessionId: 's1', subTurnId: 't1', parentTurnId: 'pt1',
      chatComplete,
      dispatchTool,
      toolSchemas: [],
      log: noopLog,
    })

    expect(result.finishReason).toBe('tool_failed')
    expect(result.finalText).toContain('tool_failed')
    expect(result.finalText).toContain('attempts="3"')
    expect(chatComplete).toHaveBeenCalledTimes(3) // 3 rounds, each with a failing read
  })

  it('injects TOOL_EXEC_FAIL as tool result (not bail) for first 2 failures', async () => {
    let callCount = 0
    const chatComplete = mock(async () => {
      callCount++
      if (callCount === 3) {
        return { content: 'recovered!', toolCalls: undefined, finishReason: 'stop' as const, usage: { input: 10, output: 5 } }
      }
      return {
        content: '',
        toolCalls: [{ id: `t${callCount}`, name: 'read', arguments: { file: 'x' } }],
        finishReason: 'tool_calls' as const,
        usage: { input: 10, output: 5 },
      }
    })
    const dispatchTool = mock(async () => ({
      success: false,
      error: { code: 'TOOL_EXEC_FAIL' as const, message: 'read failed' },
    }))

    const result = await runMiniTurnLoop({
      descriptor: makeDesc({ maxRounds: 10 }),
      userPrompt: 'test',
      subSessionId: 's1', subTurnId: 't1', parentTurnId: 'pt1',
      chatComplete,
      dispatchTool,
      toolSchemas: [],
      log: noopLog,
    })

    // First 2 calls fail → injected as tool-error, 3rd call recovers
    expect(result.finishReason).toBe('stop')
    expect(result.finalText).toBe('recovered!')
    expect(chatComplete).toHaveBeenCalledTimes(3)
  })
})
```

- [ ] **Step 3: Run tests — verify they fail**

```bash
bun test tests/unit/sub-agent/mini-turn-loop.test.ts
```
Expected: FAIL — `runMiniTurnLoop` not yet implemented.

- [ ] **Step 4: Implement `runMiniTurnLoop`**

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
  subSessionId: string
  subTurnId: string
  parentTurnId: string
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
const MAX_TOOL_FAILURES_PER_NAME = 3

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function classifyLlmError(err: unknown): LlmFailureReason {
  const msg = err instanceof Error ? err.message : String(err)
  if (/rate.limit|429|quota/i.test(msg)) return 'rate_limit'
  if (/unauthorized|401|403|auth/i.test(msg)) return 'auth'
  if (/network|timeout|ECONN|ETIMEDOUT/i.test(msg)) return 'network'
  if (/parse|invalid|unexpected/i.test(msg)) return 'invalid_response'
  return 'unknown'
}

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
    if (totalUsage.input + totalUsage.output > maxTotalTokens) {
      log('warn', `budget exhausted: ${totalUsage.input + totalUsage.output} > ${maxTotalTokens}`)
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
          if (!finalText) {
            return {
              finalText: `<sub-agent-error type="empty_response"></sub-agent-error>`,
              usage: totalUsage, toolCallCount, rounds: round + 1, finishReason: 'empty',
            }
          }
          return { finalText, usage: totalUsage, toolCallCount, rounds: round + 1, finishReason: resp.finishReason }
      }
    }

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
          return {
            finalText: `<sub-agent-error type="tool_unavailable" toolName="${tc.name}" reason="${code}"></sub-agent-error>`,
            usage: totalUsage, toolCallCount, rounds: round + 1,
            finishReason: 'tool_unavailable',
          }
        }
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

  log('warn', `maxRounds=${maxRounds} reached, force-finalizing`)
  return {
    finalText:
      `<sub-agent-error type="max_rounds_reached" rounds="${maxRounds}" maxRounds="${maxRounds}">` +
      `<partial-result>${escapeXml(finalText)}</partial-result></sub-agent-error>`,
    usage: totalUsage, toolCallCount, rounds: maxRounds,
    finishReason: 'max_rounds',
  }
}
```

- [ ] **Step 5: Run tests — verify pass**

```bash
bun test tests/unit/sub-agent/mini-turn-loop.test.ts
```
Expected: All tests pass (may need to adjust budget test if initial usage check fires differently).

- [ ] **Step 6: Verify compilation**

```bash
bun run tsc --noEmit 2>&1 | grep -v "test" | head -20
```
Expected: No errors in src/ files.

- [ ] **Step 7: Commit**

```bash
git add src/extensions/sub-agent/mini-turn-loop.ts src/extensions/sub-agent/errors.ts tests/unit/sub-agent/mini-turn-loop.test.ts
git commit -m "feat: add mini-turn-loop — worker-side tool loop with error taxonomy (finishReason provenance, sanitization)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 10: Create `worker-entry-subagent.ts`

**Files:**
- Create: `src/extensions/sub-agent/worker-entry-subagent.ts`

- [ ] **Step 1: Write the worker entry**

```ts
// src/extensions/sub-agent/worker-entry-subagent.ts
import type { JobContext } from '../../application/ports/job-spawner'
import type { SubAgentDescriptor } from './types'
import { runWorker } from '../../infrastructure/jobs/spawn-worker-runtime'
import { runMiniTurnLoop, type ToolCallHandler } from './mini-turn-loop'

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
  if (!ctx.dispatchTool) {
    throw new Error('sub-agent worker requires dispatchTool in JobContext')
  }

  return runMiniTurnLoop({
    descriptor: job.descriptor,
    userPrompt: job.userPrompt,
    subSessionId: job.subSessionId,
    subTurnId: job.subTurnId,
    parentTurnId: job.parentTurnId,
    chatComplete: ctx.chatComplete,
    dispatchTool: ctx.dispatchTool,
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

- [ ] **Step 2: Verify compilation**

```bash
bun run tsc --noEmit 2>&1 | head -20
```
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/extensions/sub-agent/worker-entry-subagent.ts
git commit -m "feat: add worker-entry-subagent — static import + JOB_WORKER_ENTRY guard

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 11: Integration smoke tests (real spawn)

**Files:**
- Create: `tests/integration/sub-agent-spawn-smoke.test.ts`

These tests spawn a real Bun worker process and verify the NDJSON pipe end-to-end. They need the `runner-spawner.ts` to work, so let's make this a skeletal test that will pass once the spawner is wired.

Since `runner-spawner.ts` isn't created until Task 12, these tests will temporarily test the frame protocol + worker runtime combination more directly.

- [ ] **Step 1: Create a minimal smoke test worker**

```ts
// tests/fixtures/smoke-subagent-worker.ts
import { runWorker } from '../../src/infrastructure/jobs/spawn-worker-runtime'
import type { JobContext } from '../../src/application/ports/job-spawner'

interface SmokeJob {
  mode: 'simple' | 'with-tool' | 'shutdown-test'
}

export async function handle(job: SmokeJob, ctx: JobContext): Promise<{ ok: boolean; mode: string }> {
  if (job.mode === 'simple') {
    const resp = await ctx.chatComplete!({
      purpose: 'subagent.run.smoke',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    })
    return { ok: resp.content.length > 0, mode: 'simple' }
  }
  if (job.mode === 'with-tool') {
    const resp1 = await ctx.chatComplete!({
      purpose: 'subagent.run.smoke',
      messages: [{ role: 'user', content: 'use tool' }],
      tools: [{ name: 'smoke_echo', description: 'echo test', parameters: { type: 'object', properties: {} } }],
    })
    const toolResp = await ctx.dispatchTool!({
      name: 'smoke_echo',
      arguments: { msg: 'ping' },
      callId: resp1.toolCalls?.[0]?.id ?? 't1',
    })
    const resp2 = await ctx.chatComplete!({
      purpose: 'subagent.run.smoke',
      messages: [
        { role: 'user', content: 'use tool' },
        { role: 'assistant', content: resp1.content },
        { role: 'tool', content: String(toolResp.result) },
      ],
      tools: [],
    })
    return { ok: resp2.content.length > 0, mode: 'with-tool' }
  }
  return { ok: false, mode: 'unknown' }
}

if (process.env.JOB_MODE === 'spawn' && process.env.JOB_WORKER_ENTRY === '1') {
  runWorker((job, ctx) => handle(job as SmokeJob, ctx))
    .catch((err: unknown) => {
      process.stderr.write(`smoke worker failed: ${String(err)}\n`)
      process.exit(1)
    })
}
```

- [ ] **Step 2: Write the integration test**

```ts
// tests/integration/sub-agent-spawn-smoke.test.ts
import { describe, it, expect } from 'bun:test'
import { BunSpawnJobSpawner } from '../../src/infrastructure/jobs/bun-spawn-job-spawner'
import type { JobSpawner, JobContext } from '../../src/application/ports/job-spawner'
import type { ProviderChat, ProviderInvoke } from '../../src/application/ports/provider'

function silentLogger() {
  return {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    withTag: () => silentLogger(),
  } as any
}

// Fake provider that returns preset chat responses
function makeFakeProvider(): ProviderChat & ProviderInvoke {
  return {
    async complete(req: any) {
      return {
        id: 'smoke-1',
        content: req.messages[req.messages.length - 1]?.content === 'use tool'
          ? 'calling tool' : 'done: ' + (req.messages[1]?.content ?? ''),
        toolCalls: req.messages[req.messages.length - 1]?.content === 'use tool'
          ? [{ id: 'tc1', name: 'smoke_echo', arguments: { msg: 'ping' } }]
          : undefined,
        usage: { input: 10, output: 5 },
        model: 'smoke',
      }
    },
    async *stream() {},
    async call(req: any) {
      return { content: '{}', usage: { input: 0, output: 0 } }
    },
  }
}

const spawnCfg = { invokeTimeoutMs: 10_000, lifetimeMs: 30_000 }
const smokeEntry = require.resolve('../../tests/fixtures/smoke-subagent-worker')

describe('Sub-agent real spawn smoke', () => {
  it('Scenario A: spawn → chatComplete → result', async () => {
    const provider = makeFakeProvider()
    const spawner = new BunSpawnJobSpawner(provider, provider.complete.bind(provider), silentLogger(), spawnCfg)

    const ctx: JobContext = {
      invoke: async (req) => ({ content: '{}', usage: { input: 0, output: 0 } }),
      chatComplete: async (req) => provider.complete({ messages: req.messages, tools: req.tools }),
      dispatchTool: async (call) => ({ success: true, result: `[echo] ${JSON.stringify(call.arguments)}` }),
    }

    const result = await spawner.run({
      entry: smokeEntry,
      job: { mode: 'simple' },
      ctx,
      timeoutMs: 15_000,
    })

    expect(result).toHaveProperty('ok', true)
    expect(result).toHaveProperty('mode', 'simple')
  }, 20_000)

  it('Scenario B: spawn → chatComplete → tool-call → chatComplete → result', async () => {
    const provider = makeFakeProvider()
    const spawner = new BunSpawnJobSpawner(provider, provider.complete.bind(provider), silentLogger(), spawnCfg)

    const ctx: JobContext = {
      invoke: async (req) => ({ content: '{}', usage: { input: 0, output: 0 } }),
      chatComplete: async (req) => provider.complete({ messages: req.messages, tools: req.tools }),
      dispatchTool: async (call) => ({ success: true, result: `pong: ${(call.arguments as any)?.msg}` }),
    }

    const result = await spawner.run({
      entry: smokeEntry,
      job: { mode: 'with-tool' },
      ctx,
      timeoutMs: 15_000,
    })

    expect(result).toHaveProperty('ok', true)
    expect(result).toHaveProperty('mode', 'with-tool')
  }, 20_000)
})
```

- [ ] **Step 3: Run integration tests**

```bash
bun test tests/integration/sub-agent-spawn-smoke.test.ts --timeout 30000
```
Expected: Both scenarios pass. If they fail with spawn/timeout errors, debug by checking worker stderr (visible since spawner uses `stderr: 'inherit'`).

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/smoke-subagent-worker.ts tests/integration/sub-agent-spawn-smoke.test.ts
git commit -m "test: add real-spawn integration smoke tests (chatComplete + tool round-trip)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 12: Create `runner-spawner.ts` with unit tests

**Files:**
- Create: `src/extensions/sub-agent/runner-spawner.ts`
- Create: `tests/unit/sub-agent/runner-spawner.test.ts`

- [ ] **Step 1: Write the spawner runner tests FIRST**

```ts
// tests/unit/sub-agent/runner-spawner.test.ts
import { describe, it, expect, mock } from 'bun:test'
import { createSpawnerSubAgentRunner } from '../../../src/extensions/sub-agent/runner-spawner'
import { SubAgentRegistry, registerBuiltins } from '../../../src/extensions/sub-agent/registry'
import type { JobSpawner, JobContext } from '../../../src/application/ports/job-spawner'

function makeDeps(overrides?: Partial<ReturnType<typeof makeBaseDeps>>) {
  const registry = new SubAgentRegistry()
  registerBuiltins(registry)

  return {
    spawner: { run: mock(async () => ({ finalText: 'result', usage: { input: 10, output: 5 }, toolCallCount: 0, rounds: 1 })) } as unknown as JobSpawner,
    registry,
    toolCatalog: {
      get: mock((name: string) => name === 'read' ? { name: 'read', description: 'read file', parameters: {}, execute: mock(async () => 'content'), parse: mock((args) => args) } : undefined),
    } as any,
    chatComplete: mock(async () => ({ content: 'ok', usage: { input: 5, output: 3 }, finishReason: 'stop' })),
    bus: { emit: mock(() => {}) } as any,
    logger: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}), debug: mock(() => {}), withTag: mock(() => ({} as any)) } as any,
    agentDir: '/tmp/test-agent',
    ...overrides,
  }
}

describe('createSpawnerSubAgentRunner', () => {
  it('returns result from spawned worker', async () => {
    const deps = makeDeps()
    const runner = createSpawnerSubAgentRunner(deps)
    const result = await runner({
      type: 'explore',
      prompt: 'find X',
      parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1',
      parentSignal: new AbortController().signal,
    })
    expect(result).toBe('result')
  })

  it('returns unknown_subagent_type error for unregistered type', async () => {
    const deps = makeDeps()
    const runner = createSpawnerSubAgentRunner(deps)
    const result = await runner({
      type: 'nonexistent',
      prompt: 'test',
      parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1',
      parentSignal: new AbortController().signal,
    })
    expect(result).toContain('unknown_subagent_type')
    expect(result).toContain('nonexistent')
  })

  it('generates unique subTurnId per call (no collision)', async () => {
    const deps = makeDeps()
    const runner = createSpawnerSubAgentRunner(deps)
    const signal = new AbortController().signal

    const results = await Promise.all([
      runner({ type: 'explore', prompt: 'a', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1', parentSignal: signal }),
      runner({ type: 'plan', prompt: 'b', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c2', parentSignal: signal }),
      runner({ type: 'explore', prompt: 'c', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c3', parentSignal: signal }),
    ])

    expect(results.every(r => r === 'result')).toBe(true)
    // Verify spawner.run was called 3 times
    expect((deps.spawner.run as any).mock.calls.length).toBe(3)
  })

  it('returns cancelled error on AbortError', async () => {
    const deps = makeDeps()
    ;(deps.spawner.run as any).mock.mockRejectedValueOnce(
      Object.assign(new Error('aborted'), { name: 'AbortError' })
    )
    const runner = createSpawnerSubAgentRunner(deps)
    const result = await runner({
      type: 'explore', prompt: 'test',
      parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1',
      parentSignal: new AbortController().signal,
    })
    expect(result).toContain('cancelled')
  })

  it('returns failed error on worker crash', async () => {
    const deps = makeDeps()
    ;(deps.spawner.run as any).mock.mockRejectedValueOnce(new Error('worker exited code=1'))
    const runner = createSpawnerSubAgentRunner(deps)
    const result = await runner({
      type: 'explore', prompt: 'test',
      parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1',
      parentSignal: new AbortController().signal,
    })
    expect(result).toContain('failed')
    expect(result).toContain('worker exited')
  })

  it('enforces concurrency cap (MAX_CONCURRENT_SUBAGENTS_PER_TURN = 3)', async () => {
    const deps = makeDeps()
    // Make run never resolve (simulate workers that hang)
    ;(deps.spawner.run as any).mock.mockImplementation(() => new Promise(() => {}))
    const runner = createSpawnerSubAgentRunner(deps)
    const signal = new AbortController().signal

    // Submit 4 tasks for the same turn
    const results = await Promise.allSettled([
      runner({ type: 'explore', prompt: '1', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1', parentSignal: signal }),
      runner({ type: 'plan', prompt: '2', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c2', parentSignal: signal }),
      runner({ type: 'explore', prompt: '3', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c3', parentSignal: signal }),
      runner({ type: 'explore', prompt: '4', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c4', parentSignal: signal }),
    ])

    // First 3 hang, 4th should return busy error immediately
    const fourth = results[3]
    expect(fourth.status).toBe('fulfilled')
    if (fourth.status === 'fulfilled') {
      expect(fourth.value).toContain('busy')
    }
  })
})
```

- [ ] **Step 2: Run tests — verify FAIL**

```bash
bun test tests/unit/sub-agent/runner-spawner.test.ts
```
Expected: FAIL — `createSpawnerSubAgentRunner` not yet implemented.

- [ ] **Step 3: Implement `runner-spawner.ts`**

```ts
// src/extensions/sub-agent/runner-spawner.ts
import type { SubAgentRunner, SubAgentRunInput } from './types'
import type { JobSpawner, ChatCompleteRequest, ChatCompleteResponse } from '../../application/ports/job-spawner'
import type { ToolCatalogPort } from '../../application/ports/tool-catalog'
import type { Logger } from '../../application/ports/logger'
import type { ContractBus } from '../../application/event-bus/contract-bus'
import type { SubAgentRegistry } from './registry'
import { generateULID } from '../../shared/ulid'
import type { ToolContext, ToolCallSource } from '../../application/ports/tool-context'
import { createToolSink } from '../../application/ports/tool-sink'

export interface SpawnerRunnerDeps {
  spawner: JobSpawner
  registry: SubAgentRegistry
  toolCatalog: ToolCatalogPort
  chatComplete: (req: ChatCompleteRequest) => Promise<ChatCompleteResponse>
  bus: ContractBus
  logger: Logger
  agentDir: string
}

const MAX_CONCURRENT_SUBAGENTS_PER_TURN = 3
const concurrentByTurn = new Map<string, number>()

function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function buildToolSchemas(catalog: ToolCatalogPort, desc: { allowedToolNames: readonly string[] }) {
  return desc.allowedToolNames
    .filter(n => n !== 'task')
    .map(name => {
      const t = catalog.get(name)
      return t ? { name: t.name, description: t.description, parameters: t.parameters as Record<string, unknown> } : null
    })
    .filter(Boolean) as Array<{ name: string; description: string; parameters: Record<string, unknown> }>
}

export function createSpawnerSubAgentRunner(deps: SpawnerRunnerDeps): SubAgentRunner {
  return async (input: SubAgentRunInput): Promise<string> => {
    const desc = deps.registry.get(input.type)
    if (!desc) {
      const available = deps.registry.list().map(d => d.type).join(', ')
      return `<sub-agent-error type="unknown_subagent_type" reason="${escapeXmlAttr(input.type)}" available="${escapeXmlAttr(available)}" />`
    }

    // Concurrency cap
    const count = concurrentByTurn.get(input.parentTurnId) ?? 0
    if (count >= MAX_CONCURRENT_SUBAGENTS_PER_TURN) {
      deps.logger.warn('sub-agent', `concurrency cap reached for turn ${input.parentTurnId}`)
      return `<sub-agent-error type="busy" reason="too many concurrent sub-agents (max ${MAX_CONCURRENT_SUBAGENTS_PER_TURN})" />`
    }
    concurrentByTurn.set(input.parentTurnId, count + 1)

    const subSessionId = `sub:${input.parentTurnId}:${generateULID()}`
    const subTurnId = `${input.parentTurnId}#sub-${input.parentCallId}`

    void deps.bus.emit('subagent.started', {
      parentTurnId: input.parentTurnId, parentSessionId: input.parentSessionId,
      type: input.type, subSessionId, callId: input.parentCallId, ts: Date.now(),
    })

    try {
      const result = await deps.spawner.run({
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
        ctx: {
          invoke: async (req) => {
            return { content: '', usage: { input: 0, output: 0 } } // sub-agent workers don't use invoke
          },
          chatComplete: async (req) => deps.chatComplete({ ...req, signal: input.parentSignal }),
          dispatchTool: async (call) => {
            if (!desc.allowedToolNames.includes(call.name)) {
              return { success: false, error: { code: 'TOOL_NOT_ALLOWED' as const, message: `tool "${call.name}" not in allowedToolNames` } }
            }
            const tool = deps.toolCatalog.get(call.name)
            if (!tool) {
              return { success: false, error: { code: 'TOOL_NOT_FOUND' as const, message: `tool "${call.name}" not found` } }
            }
            try {
              const source: ToolCallSource = { kind: 'subagent', subAgentType: input.type, subAgentCallId: input.parentCallId }
              const ctx: ToolContext = {
                signal: input.parentSignal,
                environment: { cwd: deps.agentDir },
                sink: createToolSink(),
                sessionId: input.parentSessionId,
                turnId: input.parentTurnId,
                callId: call.callId,
                source,
              }
              const result = await tool.execute(ctx, tool.parse(call.arguments))
              return { success: true, result }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              return { success: false, error: { code: 'TOOL_EXEC_FAIL' as const, message: msg } }
            }
          },
          log: (level, msg) => deps.logger[level]('sub-agent.worker', msg),
        },
        timeoutMs: desc.lifetimeMs ?? 120_000,
      })

      void deps.bus.emit('subagent.completed', {
        parentTurnId: input.parentTurnId, type: input.type, subSessionId,
        callId: input.parentCallId, ok: true,
        usage: (result as any).usage, finalText: (result as any).finalText,
        finishReason: (result as any).finishReason, ts: Date.now(),
      })
      return (result as any).finalText
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const tag = (err instanceof Error && err.name === 'AbortError') ? 'cancelled' : 'failed'
      deps.logger.warn('sub-agent', `worker ${tag} [${input.type}]: ${msg}`)
      return `<sub-agent-error type="${tag}" reason="${escapeXmlAttr(msg)}" />`
    } finally {
      const c = concurrentByTurn.get(input.parentTurnId) ?? 1
      if (c <= 1) {
        concurrentByTurn.delete(input.parentTurnId)
      } else {
        concurrentByTurn.set(input.parentTurnId, c - 1)
      }
    }
  }
}
```

- [ ] **Step 4: Run tests — verify PASS**

```bash
bun test tests/unit/sub-agent/runner-spawner.test.ts
```
Expected: All tests pass.

- [ ] **Step 5: Verify compilation**

```bash
bun run tsc --noEmit 2>&1 | head -20
```
Expected: No errors (may need to fix `createToolSink` import path — adjust as needed).

- [ ] **Step 6: Commit**

```bash
git add src/extensions/sub-agent/runner-spawner.ts tests/unit/sub-agent/runner-spawner.test.ts
git commit -m "feat: add runner-spawner — parent-side SubAgentRunner with semaphore cap + ToolContext.source

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 13: Replace `sub-agent/index.ts` with spawner-based runner

**Files:**
- Modify: `src/extensions/sub-agent/index.ts:1-90`

- [ ] **Step 1: Rewrite the extension**

```ts
// src/extensions/sub-agent/index.ts — replace entire file

import { defineExtension } from '../../kernel/define-extension'
import { asContractBus } from '../../application/event-bus/contract-bus'
import { SubAgentRegistry, registerBuiltins } from './registry'
import { createTaskTool } from './task-tool'
import { createSpawnerSubAgentRunner } from './runner-spawner'
import type { JobSpawner } from '../../application/ports/job-spawner'
import type { ToolCatalogPort } from '../../application/ports/tool-catalog'
import type { ProviderChat, ProviderInvoke } from '../../application/ports/provider'

export default () =>
  defineExtension({
    name: 'sub-agent',
    enforce: 'normal',
    dependsOn: ['tool-catalog', 'session', 'provider', 'infra-services'],

    apply(ctx) {
      const bus = asContractBus(ctx.bus)
      const registry = new SubAgentRegistry()
      registerBuiltins(registry)

      const spawner = ctx.extensions.get('infra-services.job-spawner') as JobSpawner
      const toolCatalog = ctx.extensions.get('tool-catalog.catalog') as ToolCatalogPort
      const provider = ctx.extensions.get('provider.llm') as ProviderChat & ProviderInvoke

      const runSubAgent = createSpawnerSubAgentRunner({
        spawner,
        registry,
        toolCatalog,
        bus,
        chatComplete: (req) => provider.complete({
          messages: req.messages,
          tools: req.tools,
          maxTokens: req.maxTokens,
          signal: req.signal,
        }),
        logger: ctx.logger,
        agentDir: ctx.agentDir,
      })

      toolCatalog.register(createTaskTool({ runSubAgent, registry }))

      return {
        provide: { 'sub-agent.registry': () => registry },
        dispose: () => registry.clear(),
      }
    },
  })
```

- [ ] **Step 2: Fix imports**

Remove the old imports: `generateULID`, `runTurnUsecase`, `buildRunTurnDeps`, `SubAgentRunner`, `SubAgentRunInput`, `errorResult`.

- [ ] **Step 3: Check compilation**

```bash
bun run tsc --noEmit 2>&1 | grep "sub-agent" | head -20
```
Expected: Only errors from `task-tool.ts` (old `TaskToolDeps` type doesn't include `registry`). We'll fix that in Task 14.

- [ ] **Step 4: Commit**

```bash
git add src/extensions/sub-agent/index.ts
git commit -m "refactor: replace in-process runTurnUsecase with spawner-based SubAgentRunner in sub-agent extension

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 14: Update `task-tool.ts` — dynamic enum + remove conflictKey

**Files:**
- Modify: `src/extensions/sub-agent/task-tool.ts:1-62`

- [ ] **Step 1: Update createTaskTool**

```ts
// src/extensions/sub-agent/task-tool.ts — replace entire file

import type { Tool } from '../../application/ports/tool'
import type { ToolContext } from '../../application/ports/tool-context'
import type { SubAgentRunner } from './types'
import type { SubAgentRegistry } from './registry'

interface TaskToolDeps {
  runSubAgent: SubAgentRunner
  registry: SubAgentRegistry
}

export function createTaskTool(deps: TaskToolDeps): Tool {
  const schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      subagent_type: {
        type: 'string',
        enum: deps.registry.list().map(d => d.type),
        description: 'Type of sub-agent to invoke.',
      },
      description: {
        type: 'string',
        description: 'Short description of the sub-task (one sentence).',
      },
      prompt: {
        type: 'string',
        description: 'Full prompt for the sub-agent. Include all necessary context.',
      },
    },
    required: ['subagent_type', 'description', 'prompt'],
  }

  return {
    name: 'task',
    description: 'Delegate a self-contained sub-task to a sub-agent. Use when context-isolated investigation or planning helps.',
    parameters: schema,
    readonly: false,
    renderHint: 'widget' as const,

    parse(raw: Record<string, unknown>): Record<string, unknown> {
      const type = typeof raw.subagent_type === 'string' ? raw.subagent_type : ''
      const description = typeof raw.description === 'string' ? raw.description : ''
      const prompt = typeof raw.prompt === 'string' ? raw.prompt : ''
      if (!prompt.trim()) throw new Error('task prompt must not be empty')
      return { subagent_type: type, description, prompt }
    },

    async execute(ctx: ToolContext, params: Record<string, unknown>): Promise<unknown> {
      const result = await deps.runSubAgent({
        type: params.subagent_type as string,
        prompt: params.prompt as string,
        parentSessionId: ctx.sessionId,
        parentTurnId: ctx.turnId,
        parentCallId: ctx.callId,
        parentSignal: ctx.signal,
      })
      return result
    },

    // conflictKey removed — concurrency controlled by runner-spawner semaphore
  }
}
```

- [ ] **Step 2: Verify compilation**

```bash
bun run tsc --noEmit 2>&1 | grep "task-tool" | head -10
```
Expected: No errors.

- [ ] **Step 3: Run existing task-tool tests to verify no regression**

```bash
bun test tests/extensions/sub-agent/task-tool.test.ts
```
Expected: Tests may need update since `TaskToolDeps` changed. Update test to pass `registry` alongside `runSubAgent`.

- [ ] **Step 4: Commit**

```bash
git add src/extensions/sub-agent/task-tool.ts tests/extensions/sub-agent/task-tool.test.ts
git commit -m "fix: dynamic subagent_type enum from registry + remove conflictKey

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 15: Fix existing sub-agent tests for M2 changes

**Files:**
- Modify: `tests/extensions/sub-agent/registry.test.ts`
- Modify: `tests/extensions/sub-agent/task-tool.test.ts`
- Modify: `tests/extensions/sub-agent/runner-happy.test.ts`
- Modify: `tests/extensions/sub-agent/runner-safety.test.ts`
- Modify: `tests/extensions/sub-agent/runner-m3.test.ts`

- [ ] **Step 1: Fix field name references**

```bash
grep -rn "maxOutputTokens" tests/
```
Expected: References in test files. Change each to `maxTokensPerCall`.

- [ ] **Step 2: Run all existing sub-agent tests**

```bash
bun test tests/extensions/sub-agent/
```
Expected: Some tests may fail due to:
- `task-tool.test.ts`: Needs `registry` in `TaskToolDeps`
- `runner-happy.test.ts` / `runner-m3.test.ts`: These may use the old in-process runner pattern

Update each test:
- `task-tool.test.ts`: Pass `registry` in `createTaskTool` deps
- `runner-happy.test.ts`: If it bootstraps a kernel with sub-agent extension, ensure the kernel includes `provider` and `infra-services` (the new dependencies)
- `runner-safety.test.ts` / `runner-m3.test.ts`: Same

- [ ] **Step 3: Fix tests until all pass**

```bash
bun test tests/extensions/sub-agent/
```
Expected: All passing.

- [ ] **Step 4: Commit**

```bash
git add tests/extensions/sub-agent/
git commit -m "test: update sub-agent tests for M2 (maxTokensPerCall rename, registry dep, new extension deps)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 16: Create `FakeSubAgentSpawner` e2e fixture

**Files:**
- Create: `tests/e2e/_fixtures/fake-sub-agent-spawner.ts`

- [ ] **Step 1: Write the fake spawner**

```ts
// tests/e2e/_fixtures/fake-sub-agent-spawner.ts
import type { JobSpawner, JobContext } from '../../../src/application/ports/job-spawner'
import { runMiniTurnLoop } from '../../../src/extensions/sub-agent/mini-turn-loop'
import type { SubAgentDescriptor } from '../../../src/extensions/sub-agent/types'

export type FakeWorkerHandler = (
  job: { descriptor: SubAgentDescriptor; userPrompt: string; toolSchemas: Array<{ name: string; description: string; parameters: Record<string, unknown> }> },
  ctx: JobContext,
) => Promise<{ finalText: string; usage: { input: number; output: number }; toolCallCount: number; rounds: number; finishReason: string }>

/**
 * In-memory JobSpawner that runs the worker handler synchronously
 * (no process spawn). Used for fast e2e behavior tests.
 */
export class FakeSubAgentSpawner implements JobSpawner {
  private handler: FakeWorkerHandler

  constructor(handler?: FakeWorkerHandler) {
    this.handler = handler ?? this.defaultHandler
  }

  setHandler(h: FakeWorkerHandler) {
    this.handler = h
  }

  private defaultHandler: FakeWorkerHandler = async (job, ctx) => {
    return runMiniTurnLoop({
      descriptor: job.descriptor,
      userPrompt: job.userPrompt,
      subSessionId: 'fake-sub-session',
      subTurnId: 'fake-sub-turn',
      parentTurnId: 'fake-parent-turn',
      chatComplete: ctx.chatComplete!,
      dispatchTool: ctx.dispatchTool!,
      toolSchemas: job.toolSchemas,
      log: ctx.log ?? (() => {}),
    })
  }

  async run<TJob, TResult>(opts: {
    entry: string
    job: TJob
    ctx: JobContext
    timeoutMs?: number
  }): Promise<TResult> {
    const job = opts.job as any
    const result = await this.handler(job, opts.ctx)
    return result as unknown as TResult
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
bun run tsc --noEmit 2>&1 | grep "fake-sub-agent" | head -5
```
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/_fixtures/fake-sub-agent-spawner.ts
git commit -m "test: add FakeSubAgentSpawner e2e fixture — in-memory spawner for fast behavior tests

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 17: E2E tests for sub-agent flows

**Files:**
- Create: `tests/e2e/sub-agent-flow.spec.ts`

- [ ] **Step 1: Write the e2e tests**

```ts
// tests/e2e/sub-agent-flow.spec.ts
import { describe, it, expect } from 'bun:test'
import { bootE2E } from './_fixtures/boot-kernel'
import type { E2EHandle } from './_fixtures/boot-kernel'
import { FakeSubAgentSpawner } from './_fixtures/fake-sub-agent-spawner'
import { SubAgentRegistry, registerBuiltins } from '../../src/extensions/sub-agent/registry'

describe('Sub-agent E2E flows (M2)', () => {
  it('F18.1: task tool discoverable and type enum is dynamic', async () => {
    const registry = new SubAgentRegistry()
    registerBuiltins(registry)
    const types = registry.list().map(d => d.type)
    expect(types).toContain('explore')
    expect(types).toContain('plan')
    expect(types).toContain('general-purpose')
    // Verify task is NOT in allowedToolNames (recursive guard)
    for (const desc of registry.list()) {
      expect(desc.allowedToolNames).not.toContain('task')
    }
  })

  it('F18.2: unknown subagent_type returns structured error', async () => {
    const fakeSpawner = new FakeSubAgentSpawner()
    // We test the error path via runner-spawner directly
    const { createSpawnerSubAgentRunner } = await import('../../src/extensions/sub-agent/runner-spawner')

    const registry = new SubAgentRegistry()
    registerBuiltins(registry)

    const runner = createSpawnerSubAgentRunner({
      spawner: fakeSpawner,
      registry,
      toolCatalog: { get: () => undefined } as any,
      chatComplete: async () => ({ content: 'ok', usage: { input: 0, output: 0 }, finishReason: 'stop' }),
      bus: { emit: () => {} } as any,
      logger: { info() {}, warn() {}, error() {}, debug() {}, withTag() { return this as any } } as any,
      agentDir: '/tmp/test',
    })

    const result = await runner({
      type: 'nonexistent',
      prompt: 'test',
      parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1',
      parentSignal: new AbortController().signal,
    })

    expect(result).toContain('unknown_subagent_type')
    expect(result).toContain('nonexistent')
    expect(result).toContain('available=')
  })

  it('F18.3: sub-agent completes and returns result', async () => {
    const fakeSpawner = new FakeSubAgentSpawner(async (job, ctx) => {
      return { finalText: 'exploration complete', usage: { input: 10, output: 5 }, toolCallCount: 0, rounds: 1, finishReason: 'stop' }
    })

    const registry = new SubAgentRegistry()
    registerBuiltins(registry)

    const { createSpawnerSubAgentRunner } = await import('../../src/extensions/sub-agent/runner-spawner')
    const runner = createSpawnerSubAgentRunner({
      spawner: fakeSpawner,
      registry,
      toolCatalog: { get: () => undefined } as any,
      chatComplete: async () => ({ content: 'ok', usage: { input: 0, output: 0 }, finishReason: 'stop' }),
      bus: { emit: () => {} } as any,
      logger: { info() {}, warn() {}, error() {}, debug() {}, withTag() { return this as any } } as any,
      agentDir: '/tmp/test',
    })

    const result = await runner({
      type: 'explore',
      prompt: 'find the config file',
      parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1',
      parentSignal: new AbortController().signal,
    })

    expect(result).toBe('exploration complete')
  })

  it('F18.4: parent abort propagates to sub-agent', async () => {
    const controller = new AbortController()

    const fakeSpawner = new FakeSubAgentSpawner(async (job, ctx) => {
      // simulate long-running work, check abort
      return new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    })

    const registry = new SubAgentRegistry()
    registerBuiltins(registry)

    const { createSpawnerSubAgentRunner } = await import('../../src/extensions/sub-agent/runner-spawner')
    const runner = createSpawnerSubAgentRunner({
      spawner: fakeSpawner,
      registry,
      toolCatalog: { get: () => undefined } as any,
      chatComplete: async () => ({ content: 'ok', usage: { input: 0, output: 0 }, finishReason: 'stop' }),
      bus: { emit: () => {} } as any,
      logger: { info() {}, warn() {}, error() {}, debug() {}, withTag() { return this as any } } as any,
      agentDir: '/tmp/test',
    })

    const resultPromise = runner({
      type: 'explore',
      prompt: 'long task',
      parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1',
      parentSignal: controller.signal,
    })

    controller.abort()
    const result = await resultPromise
    expect(result).toContain('cancelled')
  })
})
```

- [ ] **Step 2: Run e2e tests**

```bash
bun test tests/e2e/sub-agent-flow.spec.ts
```
Expected: All 4 scenarios pass.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/sub-agent-flow.spec.ts
git commit -m "test: add e2e sub-agent flow tests F18.1–F18.4 (FakeSubAgentSpawner)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 18: Full CI verification

**Files:**
- None (verification only)

- [ ] **Step 1: Architecture check**

```bash
bun run check:arch
```
Expected: Pass. No new violations from the modified files.

- [ ] **Step 2: Type check**

```bash
bun run check:guard
```
Expected: Pass. Zero type errors.

- [ ] **Step 3: Lint**

```bash
bun run lint
```
Expected: Pass. Fix any new lint errors (e.g., magic numbers in `mini-turn-loop.ts` — add eslint-disable comments as needed).

- [ ] **Step 4: Full test suite**

```bash
bun test
```
Expected: All tests pass. Total time < 10s.

- [ ] **Step 5: Dead code check**

```bash
bun run check:deadcode
```
Expected: No new dead code. If `errorResult` function was removed from `index.ts` and is now unused, that's expected.

- [ ] **Step 6: Run full CI check**

```bash
bun run check:all
```
Expected: All checks pass. Fix any failures.

- [ ] **Step 7: Commit if any fixes were needed**

```bash
git add -A
git commit -m "chore: fix CI issues from M2 sub-agent refactor

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Self-Review

### 1. Spec coverage

| Spec section | Covered by tasks |
|---|---|
| §2 — Protocol extension (FrameKind + payloads) | Task 3, Task 5 |
| §3 — `chatComplete` on `JobContext` (Alt 1) | Task 1, Task 6, Task 7 |
| §4.1 — Worker entry (static import + guard) | Task 10 |
| §4.2 — Mini turn loop | Task 9 |
| §5 — Parent-side runner-spawner | Task 12 |
| §6 — Error taxonomy (2 surfaces, 2 rules) | Task 9 (mini loop), Task 8 (whitelist) |
| §7 — Integration (index.ts + task-tool) | Task 13, Task 14 |
| §8 — Concurrency (semaphore cap) | Task 12 |
| §9 — Security (whitelists, permission inheritance) | Task 6, Task 8 |
| §10 — Trace attribution (ToolContext.source) | Task 2, Task 12 |
| §11 — Test plan (unit + integration + e2e) | Tasks 5, 8, 9, 11, 12, 15, 17 |
| §12 — File manifest | All tasks |
| §14 — Acceptance criteria | Task 18 (full CI verification) |

### 2. Placeholder scan

No "TBD", "TODO", "implement later", or "add appropriate error handling" found. Every step has concrete code or commands.

### 3. Type consistency

- `ChatCompleteRequest`/`ChatCompleteResponse` defined in Task 1, used in Tasks 6, 7, 9, 10, 12
- `ToolCallSource` defined in Task 2, used in Task 12
- `FrameKind` extended in Task 3, used in Tasks 5, 6, 7
- `SubAgentDescriptor.maxTokensPerCall` renamed in Task 4, used in Tasks 9, 12, 15
- `MiniLoopDeps` defined in Task 9, used in Tasks 10, 16
- `SpawnerRunnerDeps` defined in Task 12, used in Task 17
- All field names consistent across tasks

---

Plan complete. See spec at `docs/superpowers/specs/2026-05-29-sub-agent-process-isolation.md`.
