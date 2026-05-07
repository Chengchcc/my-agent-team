# Stability Optimizations — Batch 2 Design Spec

**Date**: 2026-05-07
**Scope**: Memory retrieval scoring enhancement, streaming interruption recovery, stream-level error retry
**Status**: Approved

---

## 1. Memory Retrieval Scoring Enhancement

### Problem

`KeywordRetriever.scoreEntry()` uses 4 factors: keyword match (0.4), tag match (0.3), recency from `entry.created` (0.2), and intrinsic weight (0.1). The `MemoryEntry` type already has `usageCount` and `lastHitAt` fields that are tracked by the store but never used in scoring. A frequently-used, recently-accessed memory should rank higher than one with identical text match but no usage history.

### Design

Add a `usageCount` factor to `scoreEntry()` and prefer `lastHitAt` over `created` for recency calculation.

**New weight distribution:**
- Keyword: 0.35 (was 0.4)
- Tag: 0.25 (was 0.3)
- Recency: 0.20 (unchanged, but uses `lastHitAt` fallback `created`)
- Intrinsic: 0.10 (unchanged)
- Usage: 0.10 (new)

**Usage score**: `Math.min(entry.usageCount ?? 0, 10) / 10` — capped at 10 uses for full score.

**Recency source**: `Math.max(entry.lastHitAt ?? 0, new Date(entry.created).getTime())` — use the most recent timestamp.

### Files Changed

| File | Change |
|------|--------|
| `src/memory/retriever.ts` | Adjust weights, add usage factor, use lastHitAt in recency (~30 lines) |
| `tests/memory/retriever.test.ts` | Add tests for usage factor and lastHitAt preference |

### Edge Cases

- `usageCount` undefined/null: treated as 0
- `lastHitAt` undefined/null: fallback to `entry.created`
- Both undefined: score is 0 for that factor
- Entry with high usage but low keyword match: usage factor can boost it but keyword still dominates

### Architecture Constitution Compliance

- No new public API — internal scoring change only
- No new dependencies
- File stays under 200 lines (currently 127)

---

## 2. Streaming Interruption Recovery

### Problem

In `AgentLoop.runSingleTurn()`, the `for await (const chunk of this.provider.stream(...))` loop at lines 286-325 accumulates `fullContent`, `thinkingBuffer`, and `toolCalls` incrementally. If the stream throws mid-way (network error, API restart), all accumulated content is lost. The error propagates to the top-level `catch` in `run()`, which terminates the agent loop with `agent_error` + `agent_done`. The user sees an error message but loses everything the LLM already generated.

### Design

Wrap the stream loop in try-catch. On error, check if we have partial content:

1. **Has partial content** (fullContent or toolCalls non-empty): construct an assistant message from the accumulated content, add it to context, yield `text_delta` with a truncation notice, and return `done: true` (allowing the next turn to continue naturally). Do NOT throw.
2. **No partial content** (first chunk failed): re-throw the error for the retry mechanism.

The assistant message uses `_streamInterrupted: true` metadata so hooks can optionally react.

### Files Changed

| File | Change |
|------|--------|
| `src/agent/agent-loop.ts` | Wrap stream loop in try-catch with partial content save (~30 lines) |
| `tests/integration/agent-loop-events.test.ts` | Add test for stream interruption mid-response |

### Edge Cases

- Interruption with only thinking content: include thinking in assistant message, let model know it was cut off
- Interruption during tool call streaming: tool_calls array may be incomplete — save what we have
- Double interruption (retry also fails): fall through to error retry mechanism
- Signal abort (user-initiated): `signal.aborted` check already handles this; continue to honor it

### Architecture Constitution Compliance

- No new dispatch branches
- No new hook points
- Uses existing `agent_error` event type

---

## 3. Stream-Level Error Retry

### Problem

The stream call in `runSingleTurn()` has no retry logic. Transient failures (network blip, API rate limit) immediately terminate the agent loop. For a CLI tool that may run for minutes, a single network hiccup should not kill the entire session.

### Design

Wrap the stream call (with recovery catch) in a retry function:

**Error classifier** (`classifyStreamError`):
- `network`: message contains `timeout`, `network`, `ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, `fetch failed`
- `rate_limit`: message contains `rate_limit`, `429`, `too many requests`
- `fatal`: everything else

**Retry logic**:
- Retryable (`network`, `rate_limit`): up to 3 attempts
- Backoff: 1s, 2s, 4s (exponential, no jitter needed for single-client)
- Non-retryable (`fatal`): throw immediately
- Exhausted retries: save partial content if any, then throw

**Placement**: Around the entire stream+recovery block in `runSingleTurn()`. The retry re-calls `this.provider.stream()` — a new API request.

### Files Changed

| File | Change |
|------|--------|
| `src/agent/agent-loop.ts` | Add classifyStreamError, retryWithBackoff helper, wrap stream call (~45 lines) |
| `tests/integration/agent-loop-events.test.ts` | Add test for network error retry |

### Edge Cases

- Retry succeeds on 2nd attempt: normal flow continues, no partial content from failed 1st attempt is used
- Retry succeeds but 1st attempt had partial content: partial content discarded, new stream starts fresh
- Rate limit with Retry-After header: future enhancement; use fixed backoff for now
- Signal abort during retry backoff: check `signal.aborted` before each attempt

### Architecture Constitution Compliance

- No new public API
- No new dependencies
- Pure utility functions added to agent-loop.ts
- File may approach but stays under 400 line limit (currently ~350 after refactoring)

---

## Testing Strategy

| Item | Unit Test | Integration Test |
|------|-----------|-----------------|
| Scoring enhancement | Verify usage factor math, verify lastHitAt preference | N/A (pure logic) |
| Streaming recovery | Verify partial content saved as assistant message | Verify turn continues after simulated stream break |
| Error retry | Verify error classification, verify retry count | Verify stream retries on network error, gives up on fatal |

---

## Rollout Order

Memory enhancement is independent of the other two. Streaming recovery and error retry are tightly coupled (retry wraps recovery). Implement order:

1. Memory scoring enhancement (independent)
2. Streaming interruption recovery + Error retry (coupled in agent-loop.ts)
