# TUI Wiring + Sub-Agent M3 Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all TUI data-flow disconnects, end-to-end token usage, and sub-agent M3 P1/P2 follow-ups.

**Architecture:** 6 PRs covering token usage chain (U), permission/ask-user-question overlays (D), mode/clear/todo wiring (W), code quality cleanup (T), and sub-agent error-type/warn-state/hardening (M).

**Tech Stack:** TypeScript, Bun, Zustand+immer, Ink/React, SQLite

---

## PR-1: Group U — Token Usage End-to-End (~110 LOC)

### Task 1.1: Change `fromChatStreamChunk` return type + `done` chunk contract

**Files:**
- Modify: `src/application/ports/provider-adapter.ts`
- Modify: `src/application/ports/provider.ts`

- [ ] **Step 1: Update `ChatResponseChunk` to add `finishReason` on `done`**

Read `src/application/ports/provider.ts` to find the `ChatResponseChunk` type (around line 28-33).

Edit the `done` variant:
```ts
// Before
{ type: 'done' }

// After
{ type: 'done'; finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' }
```

- [ ] **Step 2: Update `fromChatStreamChunk` signature**

Read `src/application/ports/provider-adapter.ts` to find the method signature.

Edit:
```ts
// Before
fromChatStreamChunk(raw: unknown): ChatResponseChunk | null

// After
fromChatStreamChunk(raw: unknown): ChatResponseChunk[] | null
```

- [ ] **Step 3: Run tsc to find all breakages**

Run: `bun run tsc 2>&1 | head -50`

Expected: compilation errors at openai-provider.ts, claude-provider.ts, echo-provider.ts, and turn-runner.ts (consuming `done` without `finishReason`). These will be fixed in subsequent tasks.

- [ ] **Step 4: Commit**

```bash
git add src/application/ports/provider.ts src/application/ports/provider-adapter.ts
git commit -m "feat: ChatResponseChunk.done carries finishReason, fromChatStreamChunk returns array

BREAKING: adapter interface signature change — callers must iterate array.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 1.2: Fix OpenAI adapter to emit usage + finishReason

**Files:**
- Modify: `src/infrastructure/llm/adapters/openai-adapter.ts:88-128`
- Create: `tests/infrastructure/llm/openai-adapter-usage.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/infrastructure/llm/openai-adapter-usage.test.ts
import { describe, it, expect } from 'bun:test'
import { OpenAiAdapter } from '../../../src/infrastructure/llm/adapters/openai-adapter'

const adapter = new OpenAiAdapter()

describe('OpenAiAdapter.fromChatStreamChunk', () => {
  it('returns [usage, done] for response.completed with usage', () => {
    const raw = JSON.stringify({
      type: 'response.completed',
      response: {
        usage: { input_tokens: 150, output_tokens: 80, total_tokens: 230 },
      },
    })
    const chunks = adapter.fromChatStreamChunk(raw)
    expect(chunks).not.toBeNull()
    expect(chunks!).toHaveLength(2)
    expect(chunks![0]).toEqual({ type: 'usage', usage: { input: 150, output: 80 } })
    expect(chunks![1]).toEqual({ type: 'done', finishReason: 'stop' })
  })

  it('returns [text] for response.output_text.delta', () => {
    const raw = JSON.stringify({
      type: 'response.output_text.delta',
      delta: 'hello',
    })
    const chunks = adapter.fromChatStreamChunk(raw)
    expect(chunks).toEqual([{ type: 'text', delta: 'hello' }])
  })

  it('returns [done] with finishReason for response.done (no usage)', () => {
    const raw = JSON.stringify({ type: 'response.done' })
    const chunks = adapter.fromChatStreamChunk(raw)
    expect(chunks).toEqual([{ type: 'done', finishReason: 'stop' }])
  })

  it('returns null for heartbeat events', () => {
    expect(adapter.fromChatStreamChunk(JSON.stringify({ type: 'response.created' }))).toBeNull()
    expect(adapter.fromChatStreamChunk(JSON.stringify({ type: 'response.in_progress' }))).toBeNull()
  })

  it('returns [tool_call_start] for function_call output_item.done', () => {
    const raw = JSON.stringify({
      type: 'response.output_item.done',
      item: { type: 'function_call', id: 'fc1', name: 'bash', arguments: '{"cmd":"ls"}' },
    })
    const chunks = adapter.fromChatStreamChunk(raw)
    expect(chunks).toHaveLength(1)
    expect(chunks![0].type).toBe('tool_call_start')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/infrastructure/llm/openai-adapter-usage.test.ts`

Expected: FAIL — `fromChatStreamChunk` returns single chunk not array for `response.completed`.

- [ ] **Step 3: Implement the fix**

In `src/infrastructure/llm/adapters/openai-adapter.ts:88-128`, change `fromChatStreamChunk`:

```ts
fromChatStreamChunk(raw: unknown): ChatResponseChunk[] | null {
  if (typeof raw !== 'string') return null

  let event: { type: string; [key: string]: unknown }
  try {
    event = JSON.parse(raw) as { type: string; [key: string]: unknown }
  } catch {
    return null
  }

  switch (event.type) {
    case 'response.output_text.delta': {
      const delta = event.delta as string | undefined
      if (delta) {
        return [{ type: 'text', delta }]
      }
      return null
    }
    case 'response.output_item.done': {
      const item = event.item as Record<string, unknown> | undefined
      if (item?.type === 'function_call') {
        return [{
          type: 'tool_call_start',
          toolCall: {
            id: (item.id as string) ?? '',
            name: (item.name as string) ?? '',
            arguments: JSON.stringify(item.arguments ?? {}),
          },
        }]
      }
      return null
    }
    case 'response.completed': {
      const resp = event.response as { usage?: { input_tokens: number; output_tokens: number } } | undefined
      const chunks: ChatResponseChunk[] = []
      if (resp?.usage) {
        chunks.push({ type: 'usage', usage: { input: resp.usage.input_tokens, output: resp.usage.output_tokens } })
      }
      chunks.push({ type: 'done', finishReason: 'stop' })
      return chunks
    }
    case 'response.done':
      return [{ type: 'done', finishReason: 'stop' }]
    case 'response.created':
    case 'response.in_progress':
      return null
    default:
      return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/infrastructure/llm/openai-adapter-usage.test.ts`

Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/llm/adapters/openai-adapter.ts tests/infrastructure/llm/openai-adapter-usage.test.ts
git commit -m "feat: openai-adapter emits usage chunk from response.completed

response.completed now returns [{type:'usage',usage:{input,output}},{type:'done',finishReason}].
All branches return ChatResponseChunk[] | null per updated adapter interface.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 1.3: Fix OpenAI provider to iterate array

**Files:**
- Modify: `src/infrastructure/llm/openai-provider.ts:48-51`

- [ ] **Step 1: Read current code**

Read `src/infrastructure/llm/openai-provider.ts` around line 48-51 to find the `yield` of `fromChatStreamChunk`.

- [ ] **Step 2: Update to iterate array**

```ts
// Before
const chunk = this.adapter.fromChatStreamChunk(sseEvent.data)
if (chunk !== null) yield chunk

// After
const chunks = this.adapter.fromChatStreamChunk(sseEvent.data)
if (chunks !== null) {
  for (const chunk of chunks) yield chunk
}
```

- [ ] **Step 3: Verify compilation**

Run: `bun run tsc 2>&1 | grep -i 'openai-provider'`

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/infrastructure/llm/openai-provider.ts
git commit -m "fix: openai-provider iterates fromChatStreamChunk array return

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 1.4: Fix Claude adapter to emit usage + finishReason

**Files:**
- Modify: `src/infrastructure/llm/adapters/claude-adapter.ts:141-192`
- Create: `tests/infrastructure/llm/claude-provider-usage.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/infrastructure/llm/claude-provider-usage.test.ts
import { describe, it, expect } from 'bun:test'
import { ClaudeAdapter } from '../../../src/infrastructure/llm/adapters/claude-adapter'

const adapter = new ClaudeAdapter()

describe('ClaudeAdapter.fromChatStreamChunk', () => {
  it('returns [usage, done] sequence from message_start + message_delta + message_stop', () => {
    // message_start carries input_tokens
    const startRaw = JSON.stringify({
      type: 'message_start',
      message: { usage: { input_tokens: 200 } },
    })
    // message_delta carries cumulative output_tokens
    const deltaRaw1 = JSON.stringify({
      type: 'message_delta',
      usage: { output_tokens: 50 },
    })
    const deltaRaw2 = JSON.stringify({
      type: 'message_delta',
      usage: { output_tokens: 120 },
    })
    // message_stop ends the stream
    const stopRaw = JSON.stringify({ type: 'message_stop' })

    // NOTE: Claude adapter itself does NOT accumulate — the provider layer does.
    // The adapter only parses individual events. Provider test covers accumulation.
    // This test verifies adapter parsing is correct.
    const startResult = adapter.fromChatStreamChunk(startRaw)
    const deltaResult1 = adapter.fromChatStreamChunk(deltaRaw1)
    const deltaResult2 = adapter.fromChatStreamChunk(deltaRaw2)
    const stopResult = adapter.fromChatStreamChunk(stopRaw)

    // message_start: nothing to yield (provider accumulates input tokens)
    expect(startResult).toBeNull()
    // message_delta: nothing to yield (provider accumulates output tokens)
    expect(deltaResult1).toBeNull()
    expect(deltaResult2).toBeNull()
    // message_stop: yields done
    expect(stopResult).toEqual([{ type: 'done', finishReason: 'stop' }])
  })

  it('returns [text] for text_delta', () => {
    const raw = JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'hello' },
    })
    expect(adapter.fromChatStreamChunk(raw)).toEqual([{ type: 'text', delta: 'hello' }])
  })

  it('returns [done] for message_stop', () => {
    const raw = JSON.stringify({ type: 'message_stop' })
    expect(adapter.fromChatStreamChunk(raw)).toEqual([{ type: 'done', finishReason: 'stop' }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/infrastructure/llm/claude-provider-usage.test.ts`

Expected: FAIL — `fromChatStreamChunk` returns `{ type: 'done' }` not `[{ type: 'done', finishReason: 'stop' }]`.

- [ ] **Step 3: Update adapter to return arrays**

In `src/infrastructure/llm/adapters/claude-adapter.ts:141-192`, change all branches:

```ts
fromChatStreamChunk(raw: unknown): ChatResponseChunk[] | null {
  if (typeof raw !== 'string') return null

  let event: { type: string; [key: string]: unknown }
  try {
    event = JSON.parse(raw) as { type: string; [key: string]: unknown }
  } catch {
    return null
  }

  switch (event.type) {
    case 'content_block_start': {
      const block = event.content_block as Record<string, unknown> | undefined
      if (block?.type === 'tool_use') {
        this.currentToolId = (block.id as string) ?? ''
        this.currentToolName = (block.name as string) ?? ''
      }
      return null
    }
    case 'content_block_delta': {
      const delta = event.delta as Record<string, unknown> | undefined
      if (delta?.type === 'text_delta') {
        return [{ type: 'text', delta: delta.text as string }]
      }
      if (delta?.type === 'input_json_delta') {
        return [{
          type: 'tool_call_start',
          toolCall: {
            id: this.currentToolId,
            name: this.currentToolName,
            arguments: (delta.partial_json as string) ?? '',
          },
        }]
      }
      if (delta?.type === 'thinking_delta') {
        return null
      }
      return null
    }
    case 'content_block_stop':
      this.currentToolId = ''
      this.currentToolName = ''
      return null
    case 'message_start':
    case 'message_delta':
      return null
    case 'message_stop':
      return [{ type: 'done', finishReason: 'stop' }]
    default:
      return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/infrastructure/llm/claude-provider-usage.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/llm/adapters/claude-adapter.ts tests/infrastructure/llm/claude-provider-usage.test.ts
git commit -m "feat: claude-adapter returns ChatResponseChunk[] per updated interface

All branches return array. message_stop yields [{type:'done',finishReason:'stop'}].

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 1.5: Fix Claude provider to accumulate usage in closure + iterate array

**Files:**
- Modify: `src/infrastructure/llm/claude-provider.ts:54-90`

- [ ] **Step 1: Read current claude-provider stream method**

Read `src/infrastructure/llm/claude-provider.ts` to find the `stream` method (around line 40-90).

- [ ] **Step 2: Add usage accumulation in provider closure**

Find the `for await (const sseEvent of parseSSE(...))` loop. Add closure variables before the loop:

```ts
let pendingInput = 0
let pendingOutput = 0
```

Inside the loop, after calling `this.adapter.fromChatStreamChunk(sseEvent.data)`:

```ts
const chunks = this.adapter.fromChatStreamChunk(sseEvent.data)
if (chunks === null) continue

// Track usage from raw SSE events (adapter doesn't carry this state)
const raw = JSON.parse(sseEvent.data as string)
if (raw.type === 'message_start') {
  pendingInput = raw.message?.usage?.input_tokens ?? 0
} else if (raw.type === 'message_delta') {
  pendingOutput = raw.usage?.output_tokens ?? pendingOutput
}

for (const chunk of chunks) {
  if (chunk.type === 'tool_call_start') {
    // accumulate args (existing logic)
    continue
  }
  if (chunk.type === 'done') {
    // Emit usage before done
    if (pendingInput > 0 || pendingOutput > 0) {
      yield { type: 'usage', usage: { input: pendingInput, output: pendingOutput } }
    }
    // flush tool + yield done (existing logic)
    yield chunk
    continue
  }
  yield chunk
}
```

- [ ] **Step 3: Also update inner `for (const chunk of chunks)` in echo/non-stream path if present**

Read the full file to check for other yield sites.

- [ ] **Step 4: Verify compilation**

Run: `bun run tsc 2>&1 | grep -i 'claude-provider'`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/llm/claude-provider.ts
git commit -m "feat: claude-provider accumulates usage from message_start/delta

Emits single {type:'usage'} chunk before {type:'done'} at message_stop.
Fixes U-2: Claude streaming usage now flows to turn-runner.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 1.6: Fix echo-provider done chunk + turn-runner finishReason

**Files:**
- Modify: `src/infrastructure/llm/echo-provider.ts`
- Modify: `src/domain/turn-runner.ts:38-44,88-96`
- Modify: `src/domain/turn-runner.types.ts`

- [ ] **Step 1: Fix echo-provider done chunk**

Read `src/infrastructure/llm/echo-provider.ts` to find `{ type: 'done' }`. Replace with `{ type: 'done', finishReason: 'stop' }`.

- [ ] **Step 2: Update turn-runner to use chunk.finishReason**

Read `src/domain/turn-runner.ts`.

At lines 38-44 (inside consumeRound), capture finishReason from done chunk:
```ts
} else if (chunk.type === 'done') {
  finishReasonFromStream = chunk.finishReason
  break
}
```

At lines 88-96, replace the inference:
```ts
// Before
finishReason: round.toolCalls.length > 0 ? 'tool_use' : 'stop'

// After
finishReason: finishReasonFromStream ?? (round.toolCalls.length > 0 ? 'tool_use' : 'stop')
```

- [ ] **Step 3: Add `finishReason` to RoundResult type**

Read `src/domain/turn-runner.types.ts`. Add field to `RoundResult`:
```ts
finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter'
```

- [ ] **Step 4: Verify compilation**

Run: `bun run tsc 2>&1 | head -20`

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/llm/echo-provider.ts src/domain/turn-runner.ts src/domain/turn-runner.types.ts
git commit -m "fix: turn-runner uses done.finishReason instead of local inference

Echo-provider done chunk updated to include finishReason:'stop'.
This also fixes M-4 root cause: mini-turn-loop now receives accurate finishReason.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 1.7: Fix session usage null leak (U-3)

**Files:**
- Modify: `src/extensions/session/index.ts:91-98`

- [ ] **Step 1: Fix the usage emit**

```ts
// Before
usage: { input: result.usage?.input ?? null, output: result.usage?.output ?? null }

// After
usage: result.usage ?? { input: 0, output: 0 }
```

- [ ] **Step 2: Verify**

Run: `bun run tsc`

Expected: no errors (dataplane contract already allows `{input:number, output:number}`).

- [ ] **Step 3: Commit**

```bash
git add src/extensions/session/index.ts
git commit -m "fix: session emits {input:0,output:0} instead of null usage

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 1.8: Refactor accumulateUsage → setPromptTokens + accumulateCompletionTokens (U-4)

**Files:**
- Modify: `src/extensions/frontend.tui/state/store.ts:251-259`
- Modify: `src/extensions/frontend.tui/state/types.ts:66-76`
- Modify: `src/extensions/frontend.tui/hooks/use-agent-subscription.ts:57-67`

- [ ] **Step 1: Update StatsState types**

In `types.ts`, rename `promptTokens` → `lastTurnInputTokens` and remove `contextTokens`:
```ts
export interface StatsState {
  lastTurnInputTokens: number;
  completionTokens: number;
  tokenLimit: number;
  streaming: boolean;
  streamingStartTime: number | null;
  interrupted: boolean;
  compacting: boolean;
  mode: string;
}

export const initialStats: StatsState = {
  lastTurnInputTokens: 0,
  completionTokens: 0,
  tokenLimit: 0,
  streaming: false,
  streamingStartTime: null,
  interrupted: false,
  compacting: false,
  mode: 'normal',
};
```

- [ ] **Step 2: Replace store actions**

In `store.ts`, remove `accumulateUsage` and `setContextTokens`, add:
```ts
setPromptTokens: (tokens: number) => set((s) => { s.stats.lastTurnInputTokens = tokens; }),
accumulateCompletionTokens: (tokens: number) => set((s) => { s.stats.completionTokens += tokens; }),
```

Update `StatsState` reference in `TuiStore` interface: add `setPromptTokens` and `accumulateCompletionTokens`, remove `accumulateUsage` and `setContextTokens`.

Update `buildStatsActions` return type and implementation accordingly.

- [ ] **Step 3: Update callsite**

In `use-agent-subscription.ts:57-67`:
```ts
case 'turn_completed': {
  if (event.usage) {
    store.setPromptTokens(event.usage.input);
    store.accumulateCompletionTokens(event.usage.output);
  }
  // contextTokens = lastTurnInputTokens (U-5: Footer reads directly)
  const hasToolCalls = false;
  if (hasToolCalls) {
    committer.flush();
  } else {
    committer.onTurnDone();
  }
  break;
}
```

- [ ] **Step 4: Update Footer to read lastTurnInputTokens (U-5)**

Read `src/extensions/frontend.tui/views/chrome/Footer.tsx`. Change `stats.contextTokens` → `stats.lastTurnInputTokens`.

- [ ] **Step 5: Verify compilation**

Run: `bun run tsc 2>&1 | head -20`

- [ ] **Step 6: Commit**

```bash
git add src/extensions/frontend.tui/state/store.ts src/extensions/frontend.tui/state/types.ts src/extensions/frontend.tui/hooks/use-agent-subscription.ts src/extensions/frontend.tui/views/chrome/Footer.tsx
git commit -m "refactor: split accumulateUsage into setPromptTokens + accumulateCompletionTokens

promptTokens → lastTurnInputTokens (overwrite each turn).
completionTokens → cumulative (accumulate across turns).
Footer reads lastTurnInputTokens as contextTokens estimate (U-5).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 1.9: PR-1 final verification

- [ ] **Step 1: Run full typecheck**

Run: `bun run check:guard`

Expected: no errors.

- [ ] **Step 2: Run all existing tests**

Run: `bun test`

Expected: no regressions.

- [ ] **Step 3: Run architecture check**

Run: `bun run check:arch`

Expected: no new violations.

---

## PR-2: Group D — Permission + AskUserQuestion Overlay Wiring (~150 LOC)

### Task 2.1: Add `ask-user-question.required` case to from-dataplane.ts

**Files:**
- Modify: `src/extensions/frontend.tui/transcript/from-dataplane.ts:25-80`

- [ ] **Step 1: Add case**

After the `permission.required` case (line 59-60), add:
```ts
case 'ask-user-question.required': {
  const questions = (inner.questions ?? []) as Array<{
    question: string; header: string; options: Array<{ label: string; description: string }>; multi_select?: boolean
  }>
  return {
    type: 'user_question_requested',
    sessionId: sid,
    questionId: String(inner.questionId ?? ''),
    questions,
  }
}
```

- [ ] **Step 2: Verify type check**

Run: `bun run tsc 2>&1 | grep -i 'from-dataplane'`

Expected: no errors. `user_question_requested` already exists in `transcript/types.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/extensions/frontend.tui/transcript/from-dataplane.ts
git commit -m "feat: add ask-user-question.required case to from-dataplane

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 2.2: Wire permission_requested in use-agent-subscription (D-1)

**Files:**
- Modify: `src/extensions/frontend.tui/hooks/use-agent-subscription.ts:122-125`
- Modify: `src/extensions/frontend.tui/overlays/impls/overlay-permission/use-permission-manager.ts`

- [ ] **Step 1: Convert permission manager to FIFO queue**

Read `use-permission-manager.ts`. Replace single-instance pattern with queue:

```ts
interface Pending {
  request: PermissionRequest
  resolve: (r: PermissionResponse) => void
}

const listeners = new Set<(p: Pending | null) => void>()
let queue: Pending[] = []

function notify() {
  const current = queue[0] ?? null
  listeners.forEach(fn => fn(current))
}

export function _enqueuePermissionRequest(req: PermissionRequest): Promise<PermissionResponse> {
  return new Promise((resolve) => {
    queue.push({ request: req, resolve })
    if (queue.length === 1) notify()  // only notify if this is the first
  })
}

// In usePermissionManager:
const respond = useCallback((r: PermissionResponse) => {
  const p = queue.shift()
  if (!p) return
  p.resolve(r)
  notify()  // show next in queue
}, [])

// Update the hook to read from queue[0] instead of `current`
```

- [ ] **Step 2: Wire the case in use-agent-subscription**

Replace lines 122-125:
```ts
case 'permission_requested': {
  const resp = await _enqueuePermissionRequest({
    toolName: event.toolName,
    reason: `Tool "${event.toolName}" requires permission`,
  })
  void client.sendRpc('permission.resolve', {
    reqId: event.reqId,
    decision: resp,
    sessionId,
  })
  break
}
```

- [ ] **Step 3: Commit**

```bash
git add src/extensions/frontend.tui/hooks/use-agent-subscription.ts src/extensions/frontend.tui/overlays/impls/overlay-permission/use-permission-manager.ts
git commit -m "feat: wire permission_requested to _enqueuePermissionRequest with FIFO queue

Fixes D-1: permission overlay now receives dataplane events.
Fixes D-1.c: concurrent requests queued, not overwritten.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 2.3: Wire user_question_requested in use-agent-subscription (D-2)

**Files:**
- Modify: `src/extensions/frontend.tui/hooks/use-agent-subscription.ts:122-125`
- Modify: `src/extensions/frontend.tui/overlays/impls/overlay-ask-user-question/use-ask-user-question-manager.ts`

- [ ] **Step 1: Convert ask-user-question manager to FIFO queue**

Same pattern as Task 2.2 Step 1. Replace `let current` with `let queue: Pending[]`.

- [ ] **Step 2: Wire the case**

```ts
case 'user_question_requested': {
  const result = await _enqueueAskUserQuestion({ questions: event.questions })
  if (!result.cancelled) {
    void client.sendRpc('user.answer', {
      sessionId,
      questionId: event.questionId,
      answers: result.answers,
    })
  }
  break
}
```

- [ ] **Step 3: Commit**

```bash
git add src/extensions/frontend.tui/hooks/use-agent-subscription.ts src/extensions/frontend.tui/overlays/impls/overlay-ask-user-question/use-ask-user-question-manager.ts
git commit -m "feat: wire user_question_requested to _enqueueAskUserQuestion with FIFO queue

Fixes D-2: ask-user-question overlay now receives dataplane events.
Uses existing user.answer RPC for response.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 2.4: PR-2 verification

- [ ] **Step 1: Typecheck**

Run: `bun run check:guard`

- [ ] **Step 2: Run existing overlay tests**

Run: `bun test tests/tui/overlay-host.test.tsx`

Expected: PASS (existing tests for enqueue functions)

- [ ] **Step 3: Run full test suite**

Run: `bun test`

---

## PR-3: Group W-1 + W-3 + W-5 + T-1 (~250 LOC)

### Task 3.1: Add `session.mode-changed` to dataplane (W-1 gaps 1-2)

**Files:**
- Modify: `src/application/contracts/dataplane-event.ts:31`
- Modify: `src/extensions/dataplane/index.ts:76-95`

- [ ] **Step 1: Add enum value**

In `dataplane-event.ts`, add to the union:
```ts
| 'session.mode-changed'
```

- [ ] **Step 2: Add builtInMapping**

In `dataplane/index.ts` builtInMappings array, add:
```ts
{ busEvent: 'session.modeChanged', dpType: 'session.mode-changed' },
```

- [ ] **Step 3: Commit**

```bash
git add src/application/contracts/dataplane-event.ts src/extensions/dataplane/index.ts
git commit -m "feat: register session.modeChanged → session.mode-changed dataplane mapping

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 3.2: Add mode_changed to transcript types + from-dataplane (W-1 gaps 3-4)

**Files:**
- Modify: `src/extensions/frontend.tui/transcript/types.ts:22`
- Modify: `src/extensions/frontend.tui/transcript/from-dataplane.ts:78`

- [ ] **Step 1: Add transcript event type**

In `types.ts`, add before the closing `;`:
```ts
| { type: 'mode_changed'; sessionId: string; mode: string }
```

- [ ] **Step 2: Add from-dataplane case**

Before the `default:` case in `from-dataplane.ts`:
```ts
case 'session.mode-changed':
  return { type: 'mode_changed', sessionId: sid, mode: String(inner.to ?? inner.mode ?? 'normal') }
```

- [ ] **Step 3: Commit**

```bash
git add src/extensions/frontend.tui/transcript/types.ts src/extensions/frontend.tui/transcript/from-dataplane.ts
git commit -m "feat: add mode_changed transcript event mapping

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 3.3: Wire mode_changed in use-agent-subscription + add session.getMode RPC (W-1 gaps 5-6)

**Files:**
- Modify: `src/extensions/frontend.tui/hooks/use-agent-subscription.ts:32-126`
- Modify: `src/extensions/session-mode/index.ts`
- Modify: `src/extensions/frontend.tui/session-client.ts`
- Modify: `src/extensions/frontend.tui/App.tsx`

- [ ] **Step 1: Add case in use-agent-subscription**

```ts
case 'mode_changed':
  store.setMode(event.mode)
  break
```

- [ ] **Step 2: Add session.getMode RPC**

Read `src/extensions/session-mode/index.ts`. Add to the `rpc` return object:
```ts
'session.getMode': async (params: unknown) => {
  const p = params as { sessionId?: string } | undefined
  const sid = p?.sessionId ?? MAIN_SESSION_ID
  const mode = await getMode(sid)
  return { mode }
},
```

- [ ] **Step 3: Add getMode to session-client**

In `session-client.ts`, add method:
```ts
async getMode(sessionId: string): Promise<string> {
  const result = await this.sendRpc<{ mode: string }>('session.getMode', { sessionId })
  return result.mode
}
```

- [ ] **Step 4: Call getMode on attach in App.tsx**

In the `useEffect` that handles session attach (or `session_snapshot_loaded` callback), add:
```ts
client.getMode(sessionId).then(mode => {
  useTuiStore.getState().setMode(mode)
}).catch(() => { /* mode not available */ })
```

- [ ] **Step 5: Commit**

```bash
git add src/extensions/frontend.tui/hooks/use-agent-subscription.ts src/extensions/session-mode/index.ts src/extensions/frontend.tui/session-client.ts src/extensions/frontend.tui/App.tsx
git commit -m "feat: wire mode_changed event + session.getMode RPC for reconnect

Fixes W-1: mode badge now works for both incremental changes and reconnect.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 3.4: Add session.cleared to dataplane + transcript (W-3.d)

**Files:**
- Modify: `src/application/contracts/dataplane-event.ts`
- Modify: `src/extensions/dataplane/index.ts:95`
- Modify: `src/extensions/frontend.tui/transcript/types.ts`
- Modify: `src/extensions/frontend.tui/transcript/from-dataplane.ts`
- Modify: `src/extensions/frontend.tui/state/store.ts`

- [ ] **Step 1: Add `session.cleared` DP type**

In `dataplane-event.ts`, add: `| 'session.cleared'`

- [ ] **Step 2: Add builtInMapping**

In `dataplane/index.ts`:
```ts
{ busEvent: 'session.cleared', dpType: 'session.cleared' },
```

- [ ] **Step 3: Add transcript type**

In `types.ts`:
```ts
| { type: 'session_cleared'; sessionId: string }
```

- [ ] **Step 4: Add from-dataplane case**

```ts
case 'session.cleared':
  return { type: 'session_cleared', sessionId: sid }
```

- [ ] **Step 5: Add resetStats action + wire case**

In `store.ts`, add:
```ts
resetStats: () => set((s) => {
  s.stats.lastTurnInputTokens = 0
  s.stats.completionTokens = 0
  s.stats.streaming = false
  s.stats.streamingStartTime = null
  s.stats.interrupted = false
}),
```

In `use-agent-subscription.ts`:
```ts
case 'session_cleared':
  store.resetStats()
  break
```

- [ ] **Step 6: Commit**

```bash
git add src/application/contracts/dataplane-event.ts src/extensions/dataplane/index.ts src/extensions/frontend.tui/transcript/types.ts src/extensions/frontend.tui/transcript/from-dataplane.ts src/extensions/frontend.tui/state/store.ts src/extensions/frontend.tui/hooks/use-agent-subscription.ts
git commit -m "feat: add session.cleared event flow for stats reset

W-3.d: server session.cleared → dataplane → TUI resetStats.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 3.5: Fix /clear — add waitDrained, divider, remove clearTranscript (W-3.a/b/c)

**Files:**
- Modify: `src/extensions/session/index.ts:155-163` (abort capability)
- Modify: `src/extensions/controlplane/rpc-handlers.ts:184-208`
- Modify: `src/extensions/frontend.tui/App.tsx:91-96`
- Modify: `src/application/slash/builtin/slash-clear.ts`
- Modify: `src/application/slash/builtin/slash-compact.ts`
- Modify: `src/application/usecases/run-turn.ts` (Phase 6 entry)

- [ ] **Step 1: Add waitDrained to session.abort**

In `session/index.ts`, add drain tracking:
```ts
const drainResolvers = new Map<string, () => void>()

// In the abort capability:
register: (sessionId, controller) => {
  abortControllers.set(sessionId, controller)
},
unregister: (sessionId) => {
  abortControllers.delete(sessionId)
  const resolve = drainResolvers.get(sessionId)
  if (resolve) { resolve(); drainResolvers.delete(sessionId) }
},
abort: (sessionId) => { abortControllers.get(sessionId)?.abort() },
waitDrained: async (sessionId, timeoutMs = 2000) => {
  const ctrl = abortControllers.get(sessionId)
  if (!ctrl) return  // no turn in flight
  let resolve: () => void
  const p = new Promise<void>(r => { resolve = r })
  drainResolvers.set(sessionId, resolve!)
  await Promise.race([p, new Promise<void>(r => setTimeout(r, timeoutMs))])
  drainResolvers.delete(sessionId)
},
```

- [ ] **Step 2: Update session.clear handler**

In `rpc-handlers.ts:184-208`, change:
```ts
export function makeSessionClearHandler(d: RpcHandlerDeps) {
  return async (params: unknown) => {
    const p = params as { sessionId?: string } | undefined
    const sessionId = p?.sessionId ?? MAIN_SESSION_ID
    const store = d.getStore()
    const session = await store.load(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)

    // 1. Abort current turn + wait for it to drain
    const abort = d.ctx.extensions.get('session.abort') as {
      abort: (sid: string) => void
      waitDrained: (sid: string, timeoutMs: number) => Promise<void>
    } | undefined
    if (abort) {
      abort.abort(sessionId)
      await abort.waitDrained(sessionId, 2000)
    }

    // 2. Clear history (safe now — no turn writing to it)
    const hist = d.ctx.extensions.get('session.history') as { clear: (sid: string) => Promise<void> } | undefined
    if (hist) await hist.clear(sessionId)

    // 3. Emit
    void d.contractBus.emit('session.cleared', { sessionId, ts: Date.now() }, { sessionId })
    return { ok: true, sessionId }
  }
}
```

- [ ] **Step 3: Add abort check in run-turn Phase 6**

In `run-turn.ts`, find Phase 6 (history persist, around the `appendHistory` call). Add before it:
```ts
if (controller.signal.aborted) {
  return { usage: totalUsage, success: false }
}
```

- [ ] **Step 4: Replace clearTranscript with appendDivider in App.tsx**

Delete lines 92-96 (`clearTranscript` implementation). Add:
```ts
ui: {
  appendDivider: (reason: 'clear' | 'compact') => {
    useTuiStore.getState().appendDivider(reason)
  },
  openSessionPicker: () => { /* existing */ },
},
```

- [ ] **Step 5: Update slash-clear.ts**

```ts
async resolve(_input, ctx) {
  await ctx.kernel.rpc('session.clear', { sessionId: ctx.sessionId })
  ctx.ui?.appendDivider?.('clear')
  return { kind: 'handled' }
},
```

- [ ] **Step 6: Update slash-compact.ts**

After the RPC call succeeds, add:
```ts
ctx.ui?.appendDivider?.('compact')
```

- [ ] **Step 7: Commit**

```bash
git add src/extensions/session/index.ts src/extensions/controlplane/rpc-handlers.ts src/application/usecases/run-turn.ts src/extensions/frontend.tui/App.tsx src/application/slash/builtin/slash-clear.ts src/application/slash/builtin/slash-compact.ts
git commit -m "feat: /clear Claude-aligned — retain scrollback, add divider, waitDrained race fix

W-3.a: clearTranscript removed (no ANSI escape codes).
W-3.c: waitDrained ensures turn exits before history.clear.
W-3.f: Phase 6 abort check as defense-in-depth.
W-3.b: divider rendered via FinalItemView.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 3.6: Delete store.todos + updateTodos (W-5)

**Files:**
- Modify: `src/extensions/frontend.tui/state/store.ts`
- Modify: `src/extensions/frontend.tui/state/types.ts`

- [ ] **Step 1: Delete todos from store**

In `types.ts`, delete `UITodoItem` interface. In `store.ts`:
- Remove `todos: UITodoItem[]` field from `TuiStore` interface
- Remove `updateTodos` method signature
- Remove `todos: []` from initial state
- Remove `buildTodoActions` function
- Remove `...buildTodoActions(set)` from store creation
- Remove `s.todos = []` from `clearActive`

- [ ] **Step 2: Verify no remaining references**

Run: `bun run check:deadcode`

Expected: no new dead code related to todos.

- [ ] **Step 3: Commit**

```bash
git add src/extensions/frontend.tui/state/store.ts src/extensions/frontend.tui/state/types.ts
git commit -m "refactor: delete store.todos and updateTodos (W-5)

Todos render via widget path (skills.todo-list), store field unused.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 3.7: Delete dead store actions (T-1)

**Files:**
- Modify: `src/extensions/frontend.tui/state/store.ts`

- [ ] **Step 1: Delete dead actions**

Remove from `TuiStore` interface and implementations:
- `subagentStarted` / `subagentCompleted` (D-3)
- `accumulateUsage` / `setContextTokens` (already replaced in PR-1)

Also remove `reviewNotifications` and all 4 review actions (W-4 prep — full cleanup in PR-4).

Verify `setMode` and `appendDivider` are KEPT (now have callers from W-1 and W-3).

- [ ] **Step 2: Commit**

```bash
git add src/extensions/frontend.tui/state/store.ts
git commit -m "refactor: delete dead store actions (subagent, accumulateUsage, setContextTokens)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 3.8: PR-3 verification

- [ ] **Step 1: Typecheck + tests**

Run: `bun run check:guard && bun test`

---

## PR-4: Group W-2 + W-4 + T-2 + T-3 + T-5 (~80 LOC)

### Task 4.1: Rewrite TODO_WRITE_GUIDANCE (W-2)

**Files:**
- Modify: `src/extensions/tools/index.ts:198-211`

- [ ] **Step 1: Replace the guidance constant**

Read the file to find `TODO_WRITE_GUIDANCE`. Replace the content:

```ts
const TODO_WRITE_GUIDANCE = `## Task Tracking

You have access to a \`todo_write\` tool. Use it **proactively** for any non-trivial multi-step work to give the user visible progress.

### When to use
Trigger when ANY of these are true:
- The task has 3+ distinct steps that could be enumerated upfront.
- The work will span multiple turns or take noticeable wall time.
- The user explicitly asks to plan, track, or break down work.
- You are about to execute a sequence where intermediate failures matter.

Bias toward using it. A visible plan is better than silent execution for anything beyond a single tool call.

### When NOT to use
- Single-tool answers ("read this file", "run this command").
- Pure Q&A or conversational replies.
- Trivial 1-2 step sequences.

### Usage rules
- Send the FULL list every call (replace semantics, not delta).
- Exactly one item \`in_progress\` at a time.
- Mark items \`completed\` in the same turn they finish — don't batch at the end.
- When resuming a multi-turn task, re-send the full current list (including completed items) so the user can see progress restored.
- Don't re-send an unchanged list — only call when state actually changes.`
```

- [ ] **Step 2: Commit**

```bash
git add src/extensions/tools/index.ts
git commit -m "feat: rewrite TODO_WRITE_GUIDANCE for proactive todo_write usage

SPARINGLY→proactively, ALL→ANY, adds resume re-send instruction (W-2).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 4.2: Delete review notification overlay + ghost contract (W-4)

**Files:**
- Delete: `src/extensions/frontend.tui/overlays/impls/overlay-review-notification.tsx`
- Modify: `src/extensions/frontend.tui/App.tsx:14,233`
- Modify: `src/extensions/frontend.tui/state/store.ts:276-286,81,317`
- Modify: `src/extensions/frontend.tui/state/types.ts:49-57`
- Modify: `src/application/contracts/dataplane-event.ts:23`
- Modify: `src/extensions/frontend.lark/internal/data-plane-to-agent-event.ts:38`

- [ ] **Step 1: Delete the overlay file**

```bash
rm src/extensions/frontend.tui/overlays/impls/overlay-review-notification.tsx
```

- [ ] **Step 2: Remove import and JSX from App.tsx**

Delete line 14 (`import { OverlayReviewNotification } ...`) and line 233 (`<OverlayReviewNotification />`).

- [ ] **Step 3: Remove from store**

Delete `buildReviewActions` function, `reviewNotifications` field, and all 4 action type declarations from `TuiStore` interface.

- [ ] **Step 4: Remove ReviewNotification type**

Delete the `ReviewNotification` interface from `types.ts`.

- [ ] **Step 5: Remove ghost contract**

Delete `'evolution.skillProposed'` from `dataplane-event.ts` union. Remove the case from `data-plane-to-agent-event.ts:38`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: delete review notification overlay and ghost contract (W-4)

Removes dead code: overlay-review-notification.tsx, ReviewNotification type,
review actions, evolution.skillProposed dataplane contract.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 4.3: Delete turnDone fallback dead branch (T-2)

**Files:**
- Modify: `src/extensions/frontend.tui/state/store.ts:189-200`

- [ ] **Step 1: Delete the fallback block**

Delete lines 189-200 (the `if (!hasGranular)` block). Replace with comment:
```ts
// turnStart unconditionally pushes assistant-header for this assistantId,
// so granular items are guaranteed to exist. No fallback needed.
```

- [ ] **Step 2: Commit**

```bash
git add src/extensions/frontend.tui/state/store.ts
git commit -m "refactor: delete unreachable turnDone fallback (T-2)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 4.4: Fix useLiveItem selector (T-3)

**Files:**
- Modify: `src/extensions/frontend.tui/state/selectors.ts:12-24`

- [ ] **Step 1: Simplify selector**

```ts
export function useLiveItem(): LiveAssistant | null {
  return useTuiStore((s) => s.live)
}
```

- [ ] **Step 2: Commit**

```bash
git add src/extensions/frontend.tui/state/selectors.ts
git commit -m "refactor: simplify useLiveItem selector (T-3)

Direct subscription instead of structural-key workaround.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 4.5: Add committer destroy comment (T-5)

**Files:**
- Modify: `src/extensions/frontend.tui/streaming/committer.ts:159-164`

- [ ] **Step 1: Add comment**

```ts
// callback may fire after destroy; listeners already cleared so no-op
this.notifyScheduled = false
```

- [ ] **Step 2: Commit**

```bash
git add src/extensions/frontend.tui/streaming/committer.ts
git commit -m "docs: add committer destroy callback safety comment (T-5)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 4.6: PR-4 verification

Run: `bun run check:guard && bun test`

---

## PR-5: Group M — Sub-Agent M3 Follow-up (~190 LOC)

### Task 5.1: Fix try/finally scope (M-1)

**Files:**
- Modify: `src/extensions/sub-agent/runner-spawner.ts:64-199`

- [ ] **Step 1: Wrap in try/finally**

Read the current code at lines 64-199. Restructure:

```ts
if (!tryAcquire(input.parentTurnId)) {
  // M-3.d: emit started+completed pair for busy
  const nowTs = Date.now()
  void deps.bus.emit('subagent.started', { ... })
  void deps.bus.emit('subagent.completed', {
    ...common, ok: false, usage: { input: 0, output: 0 },
    errorType: 'busy', errorMessage: `too many concurrent sub-agents`,
    finishReason: 'busy', durationMs: 0, ts: nowTs,
  })
  return '<sub-agent-error type="busy" ... />'
}

try {
  // resolveModel, emit started, spawner.run, emit completed (all inside try)
  const subSessionId = ...
  // ... rest of existing body
} catch (err) {
  // existing catch block
} finally {
  release(input.parentTurnId)
}
```

For `unknown_type` early return, same pattern — emit started+completed pair before return.

- [ ] **Step 2: Commit**

```bash
git add src/extensions/sub-agent/runner-spawner.ts
git commit -m "fix: wrap sub-agent runner body in try/finally (M-1)

Prevents concurrentByTurn counter leak if resolveModel throws.
M-3.d: busy/unknown_type paths emit started+completed pairs.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 5.2: Add mapMiniLoopFinishReasonToErrorType + ok determination (M-3.a/b/c)

**Files:**
- Modify: `src/extensions/sub-agent/runner-spawner.ts:159-195`

- [ ] **Step 1: Add mapping function**

Add before `createSpawnerSubAgentRunner`:
```ts
function mapMiniLoopFinishReasonToErrorType(fr: string): SubAgentErrorType {
  switch (fr) {
    case 'stop': return 'failed'
    case 'length': return 'response_truncated'
    case 'content_filter': return 'response_filtered'
    case 'inconsistent': return 'provider_inconsistent'
    case 'tool_unavailable': return 'tool_unavailable'
    case 'tool_failed': return 'tool_failed'
    case 'budget': return 'budget'
    case 'max_rounds': return 'max_rounds'
    case 'empty_rounds':
    case 'empty': return 'empty_response'
    case 'error': return 'llm_failed'
    default: return 'failed'
  }
}
```

- [ ] **Step 2: Update ok determination + emit**

Replace lines 159-173 (the `ok: true` path after spawner.run):
```ts
const typed = result as unknown as MiniLoopResult
const ok = typed.finishReason === 'stop'
const errorType = ok ? undefined : mapMiniLoopFinishReasonToErrorType(typed.finishReason)

void deps.bus.emit('subagent.completed', {
  parentTurnId: input.parentTurnId,
  parentSessionId: input.parentSessionId,
  subSessionId,
  type: input.type,
  callId: input.parentCallId,
  ok,
  usage: typed.usage,
  finalText: typed.finalText,  // Always pass (partial output for warn state)
  errorType,
  errorMessage: ok ? undefined : `Sub-agent finished with reason: ${typed.finishReason}`,
  finishReason: typed.finishReason,
  durationMs: Date.now() - startedAt,
  ts: Date.now(),
})
return typed.finalText
```

- [ ] **Step 3: Commit**

```bash
git add src/extensions/sub-agent/runner-spawner.ts
git commit -m "feat: map mini-loop finishReason to SubAgentErrorType (M-3)

Only finishReason='stop' → ok=true. All others → ok=false with mapped errorType.
Fixes M-3.c: accurate ok determination.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 5.3: Rename xml type strings (M-3.e)

**Files:**
- Modify: `src/extensions/sub-agent/runner-spawner.ts:61`
- Modify: `src/extensions/sub-agent/mini-turn-loop.ts:126,161,226`

- [ ] **Step 1: Rename in runner-spawner**

Line 61: `unknown_subagent_type` → `unknown_type`

- [ ] **Step 2: Rename in mini-turn-loop**

Line 126: `budget_exhausted` → `budget`
Line 161: `<sub-agent-warning type="empty_rounds">` → `<sub-agent-error type="empty_response">`
Line 226: `max_rounds_reached` → `max_rounds`

- [ ] **Step 3: Commit**

```bash
git add src/extensions/sub-agent/runner-spawner.ts src/extensions/sub-agent/mini-turn-loop.ts
git commit -m "fix: align xml error type strings with SubAgentErrorType enum (M-3.e)

unknown_subagent_type→unknown_type, budget_exhausted→budget,
max_rounds_reached→max_rounds, empty_rounds(warning)→empty_response(error).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 5.4: Fix isEmpty priority (M-4)

**Files:**
- Modify: `src/extensions/sub-agent/mini-turn-loop.ts:154-155`

- [ ] **Step 1: Narrow isEmpty**

```ts
// Before
const isEmpty = !resp.content && (!resp.toolCalls || resp.toolCalls.length === 0)
  && (resp.finishReason === 'stop' || resp.finishReason === 'tool_calls')

// After
const isEmpty = !resp.content && (!resp.toolCalls || resp.toolCalls.length === 0)
  && resp.finishReason === 'stop'
```

- [ ] **Step 2: Commit**

```bash
git add src/extensions/sub-agent/mini-turn-loop.ts
git commit -m "fix: narrow isEmpty to stop finishReason only (M-4)

Removes 'tool_calls' from isEmpty condition so provider_inconsistent
detection in handleNoToolCallsResponse is not shadowed.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 5.5: Fix widget-bridge dispose order (M-5)

**Files:**
- Modify: `src/extensions/sub-agent/widget-bridge.ts:109-115`

- [ ] **Step 1: Swap clearInterval to first**

```ts
return () => {
  clearInterval(sweepTimer)  // ← moved to first
  offStarted()
  offProgress()
  offCompleted()
  state.clear()
}
```

- [ ] **Step 2: Commit**

```bash
git add src/extensions/sub-agent/widget-bridge.ts
git commit -m "fix: clear sweep interval before unsub in widget-bridge dispose (M-5)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 5.6: Add warn state to widget-bridge + widget (M-3.h)

**Files:**
- Modify: `src/extensions/sub-agent/widget-payloads.ts`
- Modify: `src/extensions/sub-agent/widget-bridge.ts:93-95`
- Modify: `src/extensions/frontend.tui/widgets/widget-subagent-task.tsx`

- [ ] **Step 1: Extend SubAgentTaskPayload status**

Read `widget-payloads.ts`. Change status:
```ts
readonly status: 'running' | 'ok' | 'warn' | 'failed' | 'cancelled'
```

- [ ] **Step 2: Add mapToWidgetStatus in widget-bridge**

```ts
function mapToWidgetStatus(
  ok: boolean,
  errorType: SubAgentErrorType | undefined,
  hasFinalText: boolean,
): 'ok' | 'warn' | 'failed' | 'cancelled' {
  if (ok) return 'ok'
  if (errorType === 'cancelled') return 'cancelled'
  const PARTIAL_USABLE = new Set<SubAgentErrorType>(['budget', 'max_rounds', 'length', 'empty_response'])
  if (errorType && PARTIAL_USABLE.has(errorType) && hasFinalText) return 'warn'
  return 'failed'
}
```

Update the completed handler (line 93-95) to use:
```ts
const status = mapToWidgetStatus(e.ok, e.errorType, Boolean(e.finalText))
```

- [ ] **Step 3: Add ERROR_LABELS + STATUS_COLOR to widget**

Read `widget-subagent-task.tsx`. Add:
```ts
const STATUS_COLOR: Record<string, string> = {
  running: 'cyan', ok: 'green', warn: 'yellow', failed: 'red', cancelled: 'gray',
}

const ERROR_LABELS: Record<SubAgentErrorType, { label: string; severity: 'warn' | 'error' }> = {
  cancelled: { label: 'Cancelled', severity: 'warn' },
  failed: { label: 'Failed', severity: 'error' },
  busy: { label: 'Too many concurrent', severity: 'error' },
  unknown_type: { label: 'Unknown type', severity: 'error' },
  budget: { label: 'Budget exhausted', severity: 'warn' },
  max_rounds: { label: 'Max rounds reached', severity: 'warn' },
  length: { label: 'Output truncated', severity: 'warn' },
  empty_response: { label: 'Empty response', severity: 'warn' },
  content_filter: { label: 'Content filtered', severity: 'error' },
  tool_unavailable: { label: 'Tool not allowed', severity: 'error' },
  tool_failed: { label: 'Tool failed', severity: 'error' },
  provider_inconsistent: { label: 'Provider inconsistent', severity: 'error' },
  llm_failed: { label: 'LLM failed', severity: 'error' },
}
```

Use `STATUS_COLOR[payload.status]` for color and `ERROR_LABELS[payload.errorType]?.label` for tooltip.

- [ ] **Step 4: Commit**

```bash
git add src/extensions/sub-agent/widget-payloads.ts src/extensions/sub-agent/widget-bridge.ts src/extensions/frontend.tui/widgets/widget-subagent-task.tsx
git commit -m "feat: add 'warn' widget status + ERROR_LABELS for sub-agent (M-3.h)

5-status model: running/ok/warn/failed/cancelled.
warn = yellow for partial-but-usable output (budget/max_rounds/length/empty_response).
13 ERROR_LABELS with severity for human-readable display.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 5.7: Clean dead comments + dead branch (M-6)

**Files:**
- Modify: `src/extensions/sub-agent/runner-spawner.ts:101`
- Modify: `src/extensions/sub-agent/registry.ts:55`

- [ ] **Step 1: Add comment for req.model**

Line 101: add `// req.model reserved for future per-call override; currently always undefined → falls back to closure model`

- [ ] **Step 2: Delete plan agent prompt sentence**

In `registry.ts:55`, delete "Do NOT call todo_write".

- [ ] **Step 3: Commit**

```bash
git add src/extensions/sub-agent/runner-spawner.ts src/extensions/sub-agent/registry.ts
git commit -m "chore: clean dead comments and dead prompt in sub-agent (M-6)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 5.8: PR-5 verification

Run: `bun run check:guard && bun test`

---

## PR-6: Group D-3 + M-2 — Dead Code Deletion (~100 LOC)

### Task 6.1: Delete subagent-block FinalItem + store actions (D-3)

**Files:**
- Modify: `src/extensions/frontend.tui/state/types.ts:37`
- Modify: `src/extensions/frontend.tui/state/store.ts:261-272`
- Modify: `src/extensions/frontend.tui/views/final/FinalItemView.tsx:45-57`
- Modify: `src/extensions/frontend.tui/transcript/types.ts:20-21`
- Modify: `src/extensions/frontend.tui/hooks/use-agent-subscription.ts:115-120`

- [ ] **Step 1: Delete from types.ts**

Delete the `subagent-block` variant from `FinalItem` union (line 37).

- [ ] **Step 2: Delete from store.ts**

Delete `subagentStarted` and `subagentCompleted` from both `TuiStore` interface and `buildStatsActions`.

- [ ] **Step 3: Delete from FinalItemView.tsx**

Delete lines 45-57 (`case 'subagent-block':` branch).

- [ ] **Step 4: Delete from transcript/types.ts**

Delete `subagent_started` and `subagent_completed` variants (lines 20-21).

- [ ] **Step 5: Delete from use-agent-subscription.ts**

Delete lines 115-120 (both cases).

- [ ] **Step 6: Commit**

```bash
git add src/extensions/frontend.tui/state/types.ts src/extensions/frontend.tui/state/store.ts src/extensions/frontend.tui/views/final/FinalItemView.tsx src/extensions/frontend.tui/transcript/types.ts src/extensions/frontend.tui/hooks/use-agent-subscription.ts
git commit -m "refactor: delete subagent-block dead code path (D-3)

M3 widget-bridge is the only sub-agent rendering path.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 6.2: Delete dataplane sub-agent.* events (M-2)

**Files:**
- Modify: `src/extensions/dataplane/index.ts:89-91`
- Modify: `src/application/contracts/dataplane-event.ts:26-28`
- Modify: `src/extensions/frontend.lark/internal/data-plane-to-agent-event.ts:39`

- [ ] **Step 1: Delete from dataplane builtInMappings**

Delete lines 89-91 (3 `subagent.*` mappings).

- [ ] **Step 2: Delete from DataPlaneEventType**

Delete `'sub-agent.started'`, `'sub-agent.completed'`, `'sub-agent.progress'` from the union.

- [ ] **Step 3: Delete from frontend.lark**

Delete the 3 `sub-agent.*` cases from `data-plane-to-agent-event.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/extensions/dataplane/index.ts src/application/contracts/dataplane-event.ts src/extensions/frontend.lark/internal/data-plane-to-agent-event.ts
git commit -m "refactor: delete dataplane sub-agent.* event mappings (M-2)

M3 widget-bridge is the only sub-agent data contract.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### Task 6.3: PR-6 verification

Run: `bun run check:guard && bun run check:deadcode && bun test`

---

## Final Verification

- [ ] **Step 1: Full CI check**

Run: `bun run check:all`

Expected: all checks pass (typecheck + tests + arch + deadcode).

- [ ] **Step 2: Grep for removed symbols**

```bash
grep -r 'subagentStarted\|subagentCompleted\|subagent-block' src/ --include='*.ts' --include='*.tsx'
grep -r 'accumulateUsage\|setContextTokens' src/ --include='*.ts' --include='*.tsx'
grep -r 'evolution.skillProposed' src/ --include='*.ts' --include='*.tsx'
grep -r 'clearTranscript' src/ --include='*.ts' --include='*.tsx'
grep -r 'unknown_subagent_type\|max_rounds_reached\|budget_exhausted' src/ --include='*.ts' --include='*.tsx'
```

Expected: no results (all dead symbols removed).

- [ ] **Step 3: Verify invariant coverage**

Run through each invariant from the spec (I-U1 through I-M5) and confirm corresponding tests exist.
