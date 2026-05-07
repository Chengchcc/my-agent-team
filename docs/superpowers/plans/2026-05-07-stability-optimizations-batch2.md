# Batch 2 Stability Optimizations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance memory retrieval scoring with usage/lastHitAt, recover partial streaming content on interruption, and retry transient stream errors with classification and backoff.

**Architecture:** Three changes: (1) adjust scoring weights in KeywordRetriever to use existing usageCount/lastHitAt fields; (2) wrap stream loop in try-catch to save partial assistant content; (3) wrap stream call in retry helper that classifies errors and backs off on network/rate_limit errors. Tasks 2 and 3 are coupled in agent-loop.ts and should be implemented together.

**Tech Stack:** TypeScript, Bun test runner

---

### Task 1: Memory Retrieval Scoring Enhancement

**Files:**
- Modify: `src/memory/retriever.ts:8-14` (weights), `:87-125` (scoreEntry method)
- Create: `tests/memory/retriever-scoring.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/memory/retriever-scoring.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test';
import { KeywordRetriever } from '../../src/memory/retriever';
import type { MemoryEntry, MemoryStore } from '../../src/memory/types';

function makeStore(entries: MemoryEntry[]): MemoryStore {
  return {
    getAll: async () => entries,
    getByType: async () => entries,
    add: async (e) => { entries.push({ ...e, id: 'x', created: new Date().toISOString() } as MemoryEntry); return entries[entries.length - 1]!; },
    get: async () => null,
    update: async () => null,
    remove: async () => false,
    replaceAll: async () => {},
    count: async () => entries.length,
    getRecent: async (n) => entries.slice(0, n),
  };
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'test-1',
    type: 'semantic',
    text: 'User prefers React for frontend development',
    tags: ['react', 'frontend'],
    created: new Date().toISOString(),
    weight: 0.5,
    source: 'user',
    ...overrides,
  };
}

describe('KeywordRetriever scoring enhancement', () => {
  it('should rank frequently used entries higher than unused ones with same text match', async () => {
    const highUsage = makeEntry({
      id: 'high-usage',
      text: 'User prefers React',
      tags: ['react'],
      usageCount: 10,
      lastHitAt: Date.now(),
    });
    const noUsage = makeEntry({
      id: 'no-usage',
      text: 'User prefers React',
      tags: ['react'],
      usageCount: undefined,
      lastHitAt: undefined,
    });

    const store = makeStore([highUsage, noUsage]);
    const retriever = new KeywordRetriever(store, makeStore([]), makeStore([]));

    const results = await retriever.search('React');
    expect(results.length).toBeGreaterThanOrEqual(2);
    // High usage entry should rank first
    expect(results[0]!.id).toBe('high-usage');
  });

  it('should prefer entries with recent lastHitAt over older ones', async () => {
    const recentHit = makeEntry({
      id: 'recent-hit',
      text: 'Use TypeScript strict mode',
      tags: ['typescript'],
      usageCount: 1,
      lastHitAt: Date.now(), // hit just now
    });
    const oldHit = makeEntry({
      id: 'old-hit',
      text: 'Use TypeScript strict mode',
      tags: ['typescript'],
      usageCount: 1,
      lastHitAt: Date.now() - 365 * 24 * 60 * 60 * 1000, // hit a year ago
    });

    const store = makeStore([oldHit, recentHit]);
    const retriever = new KeywordRetriever(store, makeStore([]), makeStore([]));

    const results = await retriever.search('TypeScript');
    expect(results.length).toBeGreaterThanOrEqual(2);
    // Recently hit entry should rank higher
    expect(results[0]!.id).toBe('recent-hit');
  });

  it('should handle missing usageCount and lastHitAt gracefully', async () => {
    const entry = makeEntry({
      id: 'minimal',
      text: 'Use pnpm as package manager',
      tags: ['pnpm'],
      usageCount: undefined,
      lastHitAt: undefined,
    });

    const store = makeStore([entry]);
    const retriever = new KeywordRetriever(store, makeStore([]), makeStore([]));

    const results = await retriever.search('pnpm');
    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe('minimal');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/memory/retriever-scoring.test.ts
```

Expected: FAIL — high-usage entry not ranked higher, recent-hit not ranked higher. Both entries tie on keyword+tag match so current scoring puts them in insertion order.

- [ ] **Step 3: Adjust scoring weights and add usage factor**

In `src/memory/retriever.ts`, replace lines 3-6 (weight constants):

```typescript
const KEYWORD_WEIGHT = 0.35;
const TAG_WEIGHT = 0.25;
const RECENCY_WEIGHT = 0.20;
const INTRINSIC_WEIGHT = 0.10;
const USAGE_WEIGHT = 0.10;
```

- [ ] **Step 4: Update recency calculation to prefer lastHitAt**

In the `scoreEntry` method, replace lines 110-114 (recency score calculation):

```typescript
    // Recency score: use lastHitAt if available, otherwise fallback to created date
    const latestTs = Math.max(
      entry.lastHitAt ?? 0,
      new Date(entry.created).getTime(),
    );
    const ageMs = Date.now() - latestTs;
    const ageDays = ageMs / MS_PER_DAY;
    const recencyScore = Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);
```

- [ ] **Step 5: Add usage score and update return**

Replace lines 117-124 (weight score and return):

```typescript
    // Usage score: usageCount factor, capped at 10
    const usageCount = entry.usageCount ?? 0;
    const usageScore = Math.min(usageCount, 10) / 10;

    return (
      keywordScore * KEYWORD_WEIGHT +
      tagScore * TAG_WEIGHT +
      recencyScore * RECENCY_WEIGHT +
      weightScore * INTRINSIC_WEIGHT +
      usageScore * USAGE_WEIGHT
    );
```

- [ ] **Step 6: Run all retriever tests**

```bash
bun test tests/memory/retriever-scoring.test.ts tests/memory/retriever.test.ts
```

Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/memory/retriever-scoring.test.ts src/memory/retriever.ts
git commit -m "feat: add usage frequency and lastHitAt to memory retrieval scoring

Weight distribution adjusted: keyword 0.35, tag 0.25, recency 0.20,
intrinsic 0.10, usage 0.10. Recency now uses lastHitAt with fallback
to created date. Frequently-used and recently-accessed memories
rank higher than unused ones with identical keyword match.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: Streaming Interruption Recovery + Error Retry

**Files:**
- Modify: `src/agent/agent-loop.ts:286-325` (stream loop), `:143-159` (error handling)
- Create: `tests/agent/stream-recovery.test.ts`

Note: Tasks 2 and 3 are implemented together because they're tightly coupled in the stream loop area.

- [ ] **Step 1: Write the combined test**

Create `tests/agent/stream-recovery.test.ts`:

```typescript
import { describe, it, expect, vi } from 'bun:test';
import { AgentLoop } from '../../src/agent/agent-loop';
import { ContextManager } from '../../src/agent/context';
import type { Provider, AgentConfig, AgentHooks } from '../../src/types';

function makeConfig(): AgentConfig {
  return { tokenLimit: 100000 };
}

function makeHooks(): Required<AgentHooks> {
  return {
    beforeAgentRun: [],
    beforeCompress: [],
    beforeModel: [],
    afterModel: [],
    beforeAddResponse: [],
    afterAgentRun: [],
  };
}

describe('Stream interruption recovery', () => {
  it('should save partial content when stream breaks mid-response', async () => {
    const contextManager = new ContextManager({ tokenLimit: 100000 });
    let streamCallCount = 0;

    // Provider that streams some content then throws
    const flakyProvider: Provider = {
      registerTools: () => {},
      invoke: async () => { throw new Error('not used'); },
      getModelName: () => 'test',
      stream: async function*() {
        streamCallCount++;
        yield { type: 'text_delta' as const, text: 'Here is the analysis' };
        yield { type: 'text_delta' as const, text: ' of the file:' };
        // Simulate network error mid-stream
        throw new Error('fetch failed: ECONNRESET');
      },
    };

    // Create a mock dispatcher that does nothing
    const mockDispatcher = {
      dispatch: async function*() {},
      dispatchSequential: async function*() {},
      dispatchParallelBatch: async function*() {},
      dispatchParallelStreaming: async function*() {},
    } as any;

    const loop = new AgentLoop(flakyProvider, contextManager, makeHooks(), makeConfig(), mockDispatcher);

    const events: any[] = [];
    try {
      for await (const event of loop.run(
        { role: 'user', content: 'Analyze this file' },
        { maxTurns: 1, timeoutMs: 30000 },
      )) {
        events.push(event);
      }
    } catch {
      // May throw if no partial content and retries exhausted
    }

    // Check: text_delta events were emitted for the partial content
    const textEvents = events.filter((e: any) => e.type === 'text_delta');
    expect(textEvents.length).toBeGreaterThanOrEqual(2);

    // The context should contain the partial assistant message
    const ctx = contextManager.getContext(makeConfig());
    const assistantMsgs = ctx.messages.filter((m: any) => m.role === 'assistant');
    expect(assistantMsgs.length).toBeGreaterThan(0);
  });

  it('should retry on network errors up to 3 times', async () => {
    const contextManager = new ContextManager({ tokenLimit: 100000 });
    let streamCallCount = 0;

    // Provider that fails twice then succeeds
    const recoveringProvider: Provider = {
      registerTools: () => {},
      invoke: async () => { throw new Error('not used'); },
      getModelName: () => 'test',
      stream: async function*() {
        streamCallCount++;
        if (streamCallCount <= 2) {
          throw new Error('fetch failed: ETIMEDOUT');
        }
        yield { type: 'text_delta' as const, text: 'Success on attempt ' + streamCallCount };
        yield { type: 'done' as const, done: true };
      },
    };

    const mockDispatcher = {
      dispatch: async function*() {},
      dispatchSequential: async function*() {},
      dispatchParallelBatch: async function*() {},
      dispatchParallelStreaming: async function*() {},
    } as any;

    const loop = new AgentLoop(recoveringProvider, contextManager, makeHooks(), makeConfig(), mockDispatcher);

    const events: any[] = [];
    for await (const event of loop.run(
      { role: 'user', content: 'Hello' },
      { maxTurns: 1, timeoutMs: 30000 },
    )) {
      events.push(event);
    }

    // Should have retried and succeeded on 3rd attempt
    expect(streamCallCount).toBe(3);
    const doneEvents = events.filter((e: any) => e.type === 'agent_done');
    expect(doneEvents.length).toBe(1);
    expect(doneEvents[0].reason).not.toBe('error');
  });

  it('should throw immediately on fatal errors without retry', async () => {
    const contextManager = new ContextManager({ tokenLimit: 100000 });
    let streamCallCount = 0;

    // Provider that fails with a fatal error
    const fatalProvider: Provider = {
      registerTools: () => {},
      invoke: async () => { throw new Error('not used'); },
      getModelName: () => 'test',
      stream: async function*() {
        streamCallCount++;
        throw new Error('Invalid API key: authentication failed');
      },
    };

    const mockDispatcher = {
      dispatch: async function*() {},
      dispatchSequential: async function*() {},
      dispatchParallelBatch: async function*() {},
      dispatchParallelStreaming: async function*() {},
    } as any;

    const loop = new AgentLoop(fatalProvider, contextManager, makeHooks(), makeConfig(), mockDispatcher);

    const events: any[] = [];
    for await (const event of loop.run(
      { role: 'user', content: 'Hello' },
      { maxTurns: 1, timeoutMs: 30000 },
    )) {
      events.push(event);
    }

    // Should NOT retry — only 1 call
    expect(streamCallCount).toBe(1);
    const errorEvents = events.filter((e: any) => e.type === 'agent_error');
    expect(errorEvents.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/agent/stream-recovery.test.ts
```

Expected: FAIL — partial content not saved, no retries on network error, fatal errors retried unnecessarily.

- [ ] **Step 3: Add error classifier and retry helper**

In `src/agent/agent-loop.ts`, after the `NANOID_LENGTH` constant (line 28), add:

```typescript
const MAX_STREAM_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;

type StreamErrorKind = 'network' | 'rate_limit' | 'fatal';

function classifyStreamError(error: Error): StreamErrorKind {
  const msg = error.message.toLowerCase();
  if (msg.includes('timeout') || msg.includes('network') ||
      msg.includes('econnrefused') || msg.includes('enotfound') ||
      msg.includes('etimedout') || msg.includes('fetch failed') ||
      msg.includes('econnreset')) {
    return 'network';
  }
  if (msg.includes('rate_limit') || msg.includes('429') ||
      msg.includes('too many requests')) {
    return 'rate_limit';
  }
  return 'fatal';
}

function retryDelay(attempt: number): number {
  return RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

- [ ] **Step 4: Replace the stream loop with recovery + retry wrapper**

In `src/agent/agent-loop.ts`, replace lines 286-325 (the `for await (const chunk of this.provider.stream(...))` block) with:

```typescript
    // Stream from LLM with retry and partial-content recovery
    let streamError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_STREAM_RETRIES; attempt++) {
      if (signal.aborted) break;

      // Reset accumulators for each retry attempt (fresh stream = fresh content)
      if (attempt > 1) {
        fullContent = '';
        thinkingBuffer = '';
        thinkingSignature = undefined;
        toolCalls.length = 0;
        usage = undefined;
      }

      try {
        for await (const chunk of this.provider.stream(resultContext, { signal })) {
          if (signal.aborted) break;
          if (chunk.thinking) {
            thinkingBuffer += chunk.thinking;
            yield { type: 'thinking_delta', delta: chunk.thinking, turnIndex } satisfies AgentEvent;
          }
          if (chunk.thinkingSignature) {
            thinkingSignature = chunk.thinkingSignature;
            yield { type: 'thinking_done', signature: chunk.thinkingSignature, turnIndex } satisfies AgentEvent;
          }
          if (chunk.content) {
            fullContent += chunk.content;
            yield { type: 'text_delta', delta: chunk.content, turnIndex } satisfies AgentEvent;
          }
          if (chunk.tool_calls) {
            for (const tc of chunk.tool_calls) {
              if (!toolCalls.some(existing => existing.id === tc.id)) {
                toolCalls.push(tc);
              }
            }
          }
          if (chunk.usage) {
            usage = chunk.usage;
            if (usage && this.contextManager) {
              this.contextManager.updateTokenUsage(usage);
            }
          }
        }

        // Stream completed successfully — exit retry loop
        streamError = null;
        break;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const kind = classifyStreamError(error);

        if (kind === 'fatal') {
          streamError = error;
          break;
        }

        debugLog(`[agent] stream error (${kind}), attempt ${attempt}/${MAX_STREAM_RETRIES}: ${error.message}`);

        if (attempt < MAX_STREAM_RETRIES) {
          yield {
            type: 'text_delta',
            delta: `\n\n[Stream interrupted: ${error.message}. Retrying...]`,
            turnIndex,
          } satisfies AgentEvent;
          await sleep(retryDelay(attempt));
        } else {
          streamError = error;
        }
      }
    }

    // Check for signal abort before processing results
    if (signal.aborted) {
      yield { type: 'agent_error', error: new Error('Agent execution aborted'), turnIndex } satisfies AgentEvent;
      return { toolCalls: [], resultContext, done: true };
    }

    // If all retries exhausted with error, save partial content if we have anything
    if (streamError) {
      const hasPartial = fullContent.length > 0 || thinkingBuffer.length > 0 || toolCalls.length > 0;
      if (hasPartial) {
        // Save partial content as assistant message so work is not lost
        const blocks: ContentBlock[] = [];
        if (thinkingBuffer.length > 0) {
          blocks.push({ type: 'thinking', thinking: thinkingBuffer, signature: thinkingSignature ?? '' });
        }
        if (fullContent.length > 0) {
          blocks.push({ type: 'text', text: fullContent });
        }
        const assistantMsg = {
          role: 'assistant' as const,
          content: fullContent || '(interrupted)',
          ...(blocks.length > 0 ? { contentBlocks: blocks } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls.map(tc => ({ id: tc.id, name: tc.name, arguments: tc.arguments })) } : {}),
          _streamInterrupted: true,
        };
        // Add via hooks pipeline to preserve existing beforeAddResponse logic
        resultContext = { ...this.contextManager.getContext(this.config), ephemeralReminders: [] };
        this.contextManager.addMessage(assistantMsg as any);
        yield {
          type: 'text_delta',
          delta: `\n\n[Stream interrupted after ${MAX_STREAM_RETRIES} retries. Partial response saved.]`,
          turnIndex,
        } satisfies AgentEvent;
        yield { type: 'agent_error', error: streamError, turnIndex } satisfies AgentEvent;
        return { toolCalls: [], resultContext, done: true };
      }
      // No partial content — propagate the error
      throw streamError;
    }
```

- [ ] **Step 5: Run all stream recovery tests and existing agent tests**

```bash
bun test tests/agent/stream-recovery.test.ts tests/integration/agent-loop-events.test.ts
```

Expected: ALL PASS (new stream recovery tests + existing agent loop integration tests).

- [ ] **Step 6: Run full test suite to check for regressions**

```bash
bun test 2>&1 | tail -5
```

Expected: Only pre-existing failures. No new failures.

- [ ] **Step 7: Commit**

```bash
git add tests/agent/stream-recovery.test.ts src/agent/agent-loop.ts
git commit -m "feat: add streaming interruption recovery and error retry

Wrap LLM stream in retry logic with error classification:
network/rate_limit errors retry up to 3x with exponential backoff.
On exhausted retries, partial content is saved as assistant message
so the conversation can continue rather than losing all progress.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Verification

After all tasks complete, run the full test suite:

```bash
bun test
```

All pre-existing tests must pass. New tests cover:
- Memory scoring: usage factor ranking, lastHitAt preference, graceful fallback
- Stream recovery: partial content save, network retry (3 attempts), fatal no-retry
