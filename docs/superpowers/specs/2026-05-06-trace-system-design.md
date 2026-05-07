# Trace System Design — Middleware-Based Agent Loop Recording for Self-Evolution

**Date**: 2026-05-06  |  **Status**: Implemented (spec updated to match implementation)  |  **Review**: 2026-05-06
**Reference**: Hermes Agent (NousResearch/hermes-agent) architecture audit

---

## 1. Motivation

The agent currently has no structured recording of its execution — what it did, why it succeeded or failed, what patterns emerged. The Memory system captures extracted facts from conversation, but not the *process*.

This trace system provides the foundational recording layer. On top of it, a Nudge Engine periodically triggers review of accumulated traces to produce user-level skills and memories — enabling self-evolution without polluting the project workspace.

---

## 2. Design Principles

- **Per-run isolation via AgentContext** — TraceBuffer is NOT a middleware singleton. It's created in `beforeAgentRun` and stored in `AgentContext.metadata._traceBuffer`. Both middlewares read it from context. Sub-agents get their own context → their own buffer → no cross-contamination.
- **Incremental persistence** — each turn appends one NDJSON line to `{runId}.jsonl`. On crash, only the current (incomplete) turn is lost, not the entire run.
- **Non-blocking finalize** — `afterAgentRun` spawns a background microtask (`setImmediate`) for finalize + retention, so the TUI is never blocked by disk I/O.
- **Provider-agnostic usage** — records whatever the provider returns (openai shape, claude shape with cache fields) as `Record<string, number>`, not a hardcoded `prompt_tokens/completion_tokens` struct.
- **User vs project separation** — auto-generated artifacts go to `~/.my-agent/skills/`, never to the project `skills/` directory.
- **3 of 6 existing hooks used** — `beforeAgentRun` (init), `beforeAddResponse` (record LLM response), `afterAgentRun` (finalize + nudge). No new hooks.

---

## 3. Architecture

### 3.1 Hook Assignment

```
Agent Loop Phase          Hook               Trace Action
──────────────────────────────────────────────────────────
Phase 1: Setup            beforeAgentRun     new TraceBuffer → ctx.metadata._traceBuffer
                                            record userMessage
Phase 2: LLM turn         (streaming)        —
Phase 2: after streaming  beforeAddResponse  buffer.recordModelResponse(thinking, text, toolCalls, usage)
Phase 3: Tool execution   ToolMiddleware     buffer.recordToolExecution(name, success, durationMs, error?)
Phase 3: repeat           (back to Phase 2)  —
Phase 4: Teardown         afterAgentRun      setImmediate → buffer.finalize() → store.save()
                                                             → nudgeEngine.tick()
```

**Why `beforeAddResponse` (not `afterModel`)**: In `agent-loop.ts:347-353`, `context.response` is assembled AFTER the `afterModel` hook runs. `beforeAddResponse` is the first hook where `context.response` is guaranteed populated.

**Limitation — thinking not available**: `response.blocks` (including thinking blocks) are assembled at `agent-loop.ts:384`, AFTER `beforeAddResponse` fires at line 360. Therefore thinking data is NOT capturable at this hook point. The `TraceTurn.modelResponse.thinking` field is reserved for future use if the hook timing changes.

**Why `beforeAgentRun` (not constructor)**: The TraceBuffer must be created per-run (not per-middleware-instance) to isolate concurrent sub-agent runs. `beforeAgentRun` fires once at the start of every `AgentLoop.run()` call.

### 3.2 Data Flow

```
beforeAgentRun                    beforeAddResponse               ToolDispatcher
     │                                  │                              │
     │  buffer = new TraceBuffer()      │  buffer.recordModelResp()    │  buffer.recordToolExec()
     │  ctx.metadata._traceBuffer       │                              │
     │  buffer.recordUserMessage()      │                              │
     │                                  │                              │
     └──────────────┬───────────────────┴──────────────┬───────────────┘
                    │                                  │
                    │     ctx.metadata._traceBuffer     │  (both read from AgentContext)
                    │                                  │
                                     │
                               afterAgentRun
                                     │
                              setImmediate:
                                buffer.finalize()
                                store.save(trace)
                                nudgeEngine.tick(trace)
```

### 3.3 Sub-Agent Isolation

Sub-agents spawn with their own `AgentLoop` → their own `beforeAgentRun` → their own `TraceBuffer`. The parent trace and child trace are **independent TraceRuns linked by `parentRunId`**:

```typescript
interface TraceRun {
  // ...
  parentRunId?: string;  // set when this is a sub-agent run
}
```

No cross-contamination. The parent's `TraceToolMiddleware` sees only the parent's tool calls (the `sub_agent` tool itself). The child's trace captures its own internal tool calls.

---

## 4. Data Model

### 4.1 TraceRun

```typescript
interface TraceRun {
  id: string;               // nanoid (already in project deps: package.json "nanoid")
  sessionId: string;
  parentRunId?: string;     // sub-agent link
  startTime: number;        // Date.now()
  endTime: number;
  model: string;
  turns: TraceTurn[];
  summary: TraceSummary;
}
```

### 4.2 TraceTurn

```typescript
interface TraceTurn {
  turnIndex: number;        // 0-based
  userMessage?: string;     // recorded in beforeAgentRun (turn 0) or extracted from messages
  modelResponse?: {         // recorded in beforeAddResponse
    thinking?: string;
    text: string;
    toolCalls: Array<{
      name: string;
      arguments: Record<string, unknown>;
    }>;
    usage: Record<string, number>;  // provider-agnostic: includes cache_read_input_tokens etc.
  };
  toolExecutions: Array<{   // recorded by TraceToolMiddleware
    toolName: string;
    success: boolean;
    durationMs: number;
    error?: string;
  }>;
  compaction?: {
    level: string;
    beforeTokens: number;
    afterTokens: number;
  };
}
```

**Turn lifecycle**: `recordModelResponse` creates the turn with `modelResponse` set. Subsequent `recordToolExecution` calls append to `toolExecutions` of the current turn. The next `recordModelResponse` advances to a new turn.

### 4.3 TraceSummary

```typescript
interface TraceSummary {
  totalTurns: number;
  totalToolCalls: number;
  totalErrors: number;
  totalTokens: Record<string, number>;  // provider-agnostic
  outcome: "completed" | "error" | "max_turns" | "aborted";
  error?: string;
}
```

### 4.4 NudgeResult

```typescript
interface NudgeResult {
  trigger: "memory_review" | "skill_review" | "combined_review";
  traceRunId: string;
  sessionId: string;
  fingerprint: string;     // dedup key: e.g. "bash:permission_denied:3"
  reason: string;
}
```

---

## 5. Storage

### 5.1 Directory Layout

```
~/.my-agent/
  traces/
    {sessionId}/
      {runId}.jsonl        # incremental NDJSON, one line per turn
  trace-state.json         # NudgeEngine counter persistence
  skills/                  # user-level, auto-generated (Phase 2)
    {skill-name}/
      SKILL.md
```

### 5.2 Incremental Persistence (NDJSON)

Each turn appends one line immediately:

```
{"type":"turn","turnIndex":0,"userMessage":"...","modelResponse":{...}}
{"type":"tool","toolName":"bash","success":true,"durationMs":42}
{"type":"tool","toolName":"read","success":false,"durationMs":1200,"error":"ENOENT"}
{"type":"turn","turnIndex":1,...}
```

On `afterAgentRun`, finalize writes the summary as the last line:

```
{"type":"summary","totalTurns":2,...}
```

- **Crash safety**: only the current (incomplete) line is lost. All prior turns are already on disk.
- **Reader**: to reconstruct a TraceRun, read all lines and assemble.
- **Retention**: per-session, max 50 runs. On save, count files in `{sessionId}/` directory and delete oldest if > 50.

### 5.3 TraceStore Interface

```typescript
interface TraceStore {
  /** Append a turn line to the run's NDJSON file (called per turn). */
  appendTurn(runId: string, sessionId: string, entry: TraceEntry): Promise<void>;
  /** Write the summary line + enforce session retention (called once in afterAgentRun). */
  finalize(trace: TraceRun): Promise<void>;
  /** Reconstruct a full TraceRun from NDJSON lines.
   *  Note: startTime, endTime, and model are not persisted in NDJSON —
   *  they return as 0, 0, and '' respectively after reconstruction. */
  get(runId: string, sessionId: string): Promise<TraceRun | null>;
  /** List run IDs for a session, newest first. */
  listBySession(sessionId: string, limit?: number): Promise<string[]>;
  /** List recent runs across all sessions. */
  listRecent(sessionLimit?: number, runLimit?: number): Promise<TraceRun[]>;
}
```

### 5.4 Privacy / Redaction

Trace records `toolCall.arguments` in `modelResponse.toolCalls`. These may contain sensitive paths, hostnames, or tokens. A `Redactor` interface allows users to customize this:

```typescript
interface TraceRedactor {
  /** Redact sensitive values from a tool call's arguments. */
  redactToolArguments(toolName: string, args: Record<string, unknown>): Record<string, unknown>;
  /** Redact sensitive data from text content. */
  redactText(text: string): string;
}
```

**Default redactor**: replaces values matching common secret patterns (`sk-...`, `ghp_...`, `-----BEGIN...`) with `[REDACTED]`. Recursively redacts nested objects and arrays. Truncates string values that look like paths (contain `/`) and exceed 120 characters to `.../basename` form. Users can override in settings via `redaction.mode: "none"`.

Configuration:
```json
{
  "trace": {
    "redaction": {
      "mode": "default"       // "default" | "none" | "custom"
      // "customRedactorPath": "~/.my-agent/redactor.js"  // future
    }
  }
}
```

---

## 6. Middleware Details

### 6.1 TraceBuffer

Created per-run, stored in `AgentContext.metadata._traceBuffer`:

```typescript
class TraceBuffer {
  readonly runId: string;
  readonly sessionId: string;
  readonly parentRunId?: string;
  private startTime: number;
  private turns: TraceTurn[] = [];
  private currentTurnIndex = -1;
  private store: TraceStore;

  constructor(sessionId: string, store: TraceStore, parentRunId?: string) {
    this.sessionId = sessionId;
    this.store = store;
    this.parentRunId = parentRunId;
    this.runId = nanoid();
    this.startTime = Date.now();
  }

  /** Called in beforeAgentRun. */
  recordUserMessage(message: string): void { /* stored for turn 0 */ }

  /** Called in beforeAddResponse. Creates or advances to a new turn. */
  recordModelResponse(resp: ModelResponseRecord): void {
    this.currentTurnIndex++;
    this.turns[this.currentTurnIndex] = {
      turnIndex: this.currentTurnIndex,
      modelResponse: resp,
      toolExecutions: [],
    };
    this.appendToFile({ type: "turn", turnIndex: this.currentTurnIndex, ...resp });
  }

  /** Called by TraceToolMiddleware. Appends to current turn. */
  recordToolExecution(exec: ToolExecutionRecord): void {
    const turn = this.turns[this.currentTurnIndex];
    if (turn) {
      turn.toolExecutions.push(exec);
    }
    this.appendToFile({ type: "tool", ...exec });
  }

  /** Called in afterAgentRun (sync, returns TraceRun without writing). */
  finalize(model: string, outcome?: TraceSummary['outcome']): TraceRun {
    const summary = this.computeSummary(outcome);
    return {
      id: this.runId, sessionId: this.sessionId,
      parentRunId: this.parentRunId,
      startTime: this.startTime, endTime: Date.now(),
      model,
      turns: this.turns,
      summary,
    };
  }

  private enqueueWrite(entry: TraceEntry): void { /* sequential NDJSON append — no await */ }
  private computeSummary(overrideOutcome?: TraceSummary['outcome']): TraceSummary {
    // outcome: 'error' if totalErrors > 0, otherwise 'completed'
    // overrideOutcome allows caller to signal 'max_turns' / 'aborted' (future)
  }
  flush(): Promise<void> { /* wait for pending writes */ }
}
```

### 6.2 TraceToolMiddleware

Registered **last** in the ToolDispatcher middleware array (onion: outermost wrapper).

Registration in `runtime.ts`:
```typescript
const toolMiddlewares: ToolMiddleware[] = [];
toolMiddlewares.push(permissionMiddleware);   // index 0 → outermost
toolMiddlewares.push(readCacheMiddleware);    // index 1
toolMiddlewares.push(traceToolMiddleware);    // index 2 → innermost (closest to tool.execute)
```

Onion execution: `permission → read-cache → trace → tool.execute`

```typescript
class TraceToolMiddleware implements ToolMiddleware {
  name = "trace";

  async handle(toolCall: ToolCall, ctx: ToolContext, next: () => Promise<unknown>): Promise<unknown> {
    const buffer = ctx.agentContext.metadata?._traceBuffer as TraceBuffer | undefined;
    if (!buffer) return next();  // trace disabled or not in agent context

    const start = Date.now();
    try {
      const result = await next();
      buffer.recordToolExecution({
        toolName: toolCall.name,
        success: true,
        durationMs: Date.now() - start,
      });
      return result;
    } catch (error) {
      buffer.recordToolExecution({
        toolName: toolCall.name,
        success: false,
        durationMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
```

### 6.3 TraceAgentMiddleware

Implements `AgentMiddleware` with three hooks:

```typescript
class TraceAgentMiddleware implements AgentMiddleware {
  constructor(
    private store: TraceStore,
    private nudgeEngine: NudgeEngine,
    private redactor: TraceRedactor,
  ) {}

  /** Create TraceBuffer per-run, record user message. */
  beforeAgentRun: Middleware = async (context, next) => {
    // Determine parentRunId for sub-agents
    const parentRunId = context.metadata._parentTraceRunId as string | undefined;
    const buffer = new TraceBuffer(this.sessionId(context), this.store, parentRunId);
    context.metadata._traceBuffer = buffer;

    // Record user message (last user message in context)
    const lastUserMsg = [...context.messages].reverse().find(m => m.role === 'user');
    if (lastUserMsg) {
      buffer.recordUserMessage(lastUserMsg.content);
    }

    return next();
  };

  /** Record LLM response. Note: thinking is NOT available here —
   *  response.blocks are assembled after this hook fires (agent-loop.ts:384). */
  beforeAddResponse: Middleware = async (context, next) => {
    const ctx = await next();
    const buffer = ctx.metadata._traceBuffer as TraceBuffer | undefined;
    if (!buffer || !ctx.response) return ctx;

    buffer.recordModelResponse({
      text: this.redactor.redactText(ctx.response.content),
      toolCalls: (ctx.response.tool_calls ?? []).map(tc => ({
        name: tc.name,
        arguments: this.redactor.redactToolArguments(tc.name, tc.arguments),
      })),
      usage: ctx.response.usage as Record<string, number>,
    });

    return ctx;
  };

  /** Finalize + persist + nudge (non-blocking). */
  afterAgentRun: Middleware = async (context, next) => {
    const ctx = await next();
    const buffer = ctx.metadata._traceBuffer as TraceBuffer | undefined;
    if (!buffer) return ctx;

    const model = ctx.response?.model ?? 'unknown';
    const trace = buffer.finalize(model);

    // Non-blocking: spawn microtask so TUI is never blocked by disk I/O
    setImmediate(() => {
      void this.finalizeTrace(trace);
    });

    return ctx;
  };

  private sessionId(context: AgentContext): string {
    return (context.metadata.sessionId as string) || 'unknown';
  }
}
```

---

## 7. Nudge Engine

### 7.1 Trigger Model — Three Independent Signals

A single counter (`turnsSinceReview`) treats "one 15-turn task" and "fifteen 1-turn messages" identically, but their review value differs. The NudgeEngine uses three independent signals:

| Signal | Condition | Rationale |
|--------|-----------|-----------|
| **Error burst** | `errors ≥ 2` AND `errors/turns ≥ 0.3` within a single run | Errors are the highest-value review signal — capture failure patterns while context is fresh |
| **Complex task** | `turns ≥ 5` AND `errors = 0` within a single run | Successful complex tasks are candidates for skill extraction |
| **Periodic** | Accumulated turns across runs ≥ `reviewInterval` | Catch-all for long-running sessions with no error bursts |

A fingerprint dedup (per signal type) prevents reviewing the same error pattern repeatedly.

```typescript
interface NudgeState {
  turnsSinceReview: number;
  fingerprints: Record<string, string[]>;  // per signal: last 5 fingerprints
  lastReviewAt: number;
}

const MIN_REVIEW_INTERVAL_MS = 5 * 60 * 1000;  // 5 min between reviews

class NudgeEngine {
  private state: NudgeState;
  private reviewInterval: number;  // default 10, from settings

  constructor(private statePath: string, reviewInterval: number = 10) {
    this.reviewInterval = reviewInterval;
    this.state = this.defaultState();
    this.loadState();
  }

  tick(trace: TraceRun): NudgeResult | null {
    // Guard: don't review more than once per MIN_REVIEW_INTERVAL_MS
    if (Date.now() - this.state.lastReviewAt < MIN_REVIEW_INTERVAL_MS) {
      return null;
    }

    // Signal 1: Error burst (immediate — don't wait for periodic counter)
    const errorRatio = trace.summary.totalTurns > 0
      ? trace.summary.totalErrors / trace.summary.totalTurns
      : 0;
    if (trace.summary.totalErrors >= 2 && errorRatio >= 0.3) {
      const fp = this.buildFingerprint(trace);
      if (!this.isDuplicate('error_burst', fp)) {
        return this.emit('error_burst', trace, fp);
      }
    }

    // Signal 2: Complex task completed successfully
    if (trace.summary.totalTurns >= 5 && trace.summary.totalErrors === 0) {
      const fp = 'complex:' + this.buildFingerprint(trace);
      if (!this.isDuplicate('complex_task', fp)) {
        return this.emit('complex_task', trace, fp);
      }
    }

    // Signal 3: Periodic — accumulated turns across runs
    this.state.turnsSinceReview += trace.summary.totalTurns;
    if (this.state.turnsSinceReview >= this.reviewInterval) {
      this.state.turnsSinceReview = 0;
      const fp = this.buildFingerprint(trace);
      if (!this.isDuplicate('periodic', fp)) {
        return this.emit('periodic', trace, fp);
      }
    }

    return null;
  }

  private emit(
    signal: 'error_burst' | 'complex_task' | 'periodic',
    trace: TraceRun,
    fingerprint: string,
  ): NudgeResult {
    this.state.lastReviewAt = Date.now();
    this.recordFingerprint(signal, fingerprint);
    return {
      trigger: this.signalToTrigger(signal, trace),
      traceRunId: trace.id,
      sessionId: trace.sessionId,
      fingerprint: `${signal}:${fingerprint}`,
      reason: this.buildReason(signal, trace),
    };
  }

  private signalToTrigger(
    signal: string, trace: TraceRun,
  ): NudgeResult['trigger'] {
    if (signal === 'error_burst' && trace.summary.totalTurns >= 5) {
      return 'combined_review';
    }
    if (signal === 'error_burst') return 'memory_review';
    return 'skill_review';
  }

  private buildReason(signal: string, trace: TraceRun): string {
    const e = trace.summary.totalErrors;
    const t = trace.summary.totalTurns;
    switch (signal) {
      case 'error_burst':
        return `${e} errors in ${t} turns (error rate: ${(e/t*100).toFixed(0)}%) — review for failure patterns`;
      case 'complex_task':
        return `${t}-turn task completed successfully — candidate for skill extraction`;
      case 'periodic':
        return `Periodic review after ${this.reviewInterval} accumulated turns`;
    }
  }

  private buildFingerprint(trace: TraceRun): string {
    const errorTools = new Set<string>();
    for (const turn of trace.turns) {
      for (const exec of turn.toolExecutions) {
        if (!exec.success) errorTools.add(exec.toolName);
      }
    }
    return [...errorTools].sort().join(',') || 'no_errors';
  }

  private isDuplicate(signal: string, fp: string): boolean {
    return (this.state.fingerprints[signal] ?? []).includes(fp);
  }

  private recordFingerprint(signal: string, fp: string): void {
    const list = this.state.fingerprints[signal] ?? [];
    list.unshift(fp);
    this.state.fingerprints[signal] = list.slice(0, 5);
  }

  async persist(): Promise<void> { /* write JSON to this.statePath */ }

  private defaultState(): NudgeState { /* fresh state */ }
  private loadState(): void { /* sync read JSON from this.statePath, merge with defaults */ }
}
```

### 7.2 Review Prompt Templates (Phase 2)

When Phase 2 activates, `NudgeResult.trigger` selects the review prompt template:

**`memory_review`** (error burst, low-complexity):
> Review this trace. Focus on: (1) What went wrong — identify the root cause of each tool error, (2) Are there user preferences or project conventions that could prevent this? (3) Write findings to memory using the memory tool. If nothing actionable, say "Nothing to save."

**`skill_review`** (complex task, no errors):
> Review this trace of a successful multi-step task. Focus on: (1) What was the sequence of steps? (2) Were there any non-obvious workarounds or tool-usage patterns? (3) Create or update a skill capturing the workflow. Include pitfalls section if any step could go wrong. If no reusable pattern, say "Nothing to save."

**`combined_review`** (error burst + complex):
> Review this trace. It had both errors and multiple turns. Focus on: (1) Root causes of errors — capture as memory entries, (2) The overall workflow — capture as a skill with pitfalls derived from the errors, (3) User corrections or preferences observed. If nothing actionable, say "Nothing to save."

All review output writes to `~/.my-agent/memory/` and `~/.my-agent/skills/auto/` only. Project directories are never modified.

### 7.3 Storage Efficiency

- **Retention**: Per-session, max 50 runs. After `finalize()`, count files in `{sessionId}/` directory. If > 50, unlink oldest.
- **Scan cost**: `listBySession` reads a single directory (O(files-in-session)). `listRecent` caps at scanning 10 most-recently-modified session directories — not all sessions.
- **NDJSON append**: Each `appendTurn` / `appendToolExec` does a single `fs.appendFile` write. No directory scan.
- **state.json size**: NudgeEngine state is ~500 bytes. Written on `persist()` after each review trigger.

---

## 8. Configuration

```json
{
  "trace": {
    "enabled": true,
    "maxRunsPerSession": 50,
    "redaction": {
      "mode": "default"
    },
    "nudge": {
      "enabled": true,
      "reviewInterval": 10
    }
  }
}
```

---

## 9. File Structure

```
src/trace/
  types.ts              # TraceRun, TraceTurn, TraceSummary, TraceEntry, TraceRedactor, NudgeState
  trace-buffer.ts       # TraceBuffer — per-run, stored in AgentContext.metadata
  store.ts              # TraceStore — NDJSON append + finalize + retention + list
  redactor.ts           # DefaultRedactor + redactToolArguments / redactText
  tool-middleware.ts    # TraceToolMiddleware
  agent-middleware.ts   # TraceAgentMiddleware (hooks: beforeAgentRun, beforeAddResponse, afterAgentRun)
  nudge-engine.ts       # NudgeEngine — counter + fingerprint dedup + persist
  index.ts              # createTraceMiddleware() factory
```

---

## 10. Integration Points

### 10.1 Runtime wiring (`src/runtime.ts`)

```typescript
// Inside createAgentRuntime():
import { createTraceMiddleware } from './trace';

const hooks: Required<Pick<AgentHooks, 'beforeAgentRun' | 'beforeModel' | 'beforeAddResponse' | 'afterAgentRun'>> = {
  beforeAgentRun: [], beforeModel: [], beforeAddResponse: [], afterAgentRun: [],
};

const toolMiddlewares: ToolMiddleware[] = [
  new PermissionMiddleware({ denyInSubAgent: [...] }),
  new ReadCacheMiddleware(),
];

// Trace wiring (enabled by default, respects settings.trace.enabled === false)
const traceEnabled = settings?.trace?.enabled !== false;
if (traceEnabled) {
  const traceMw = createTraceMiddleware({
    maxRunsPerSession: settings?.trace?.maxRunsPerSession,
    redactionMode: settings?.trace?.redaction?.mode,
    nudgeEnabled: settings?.trace?.nudge?.enabled,
    reviewInterval: settings?.trace?.nudge?.reviewInterval,
  });
  hooks.beforeAgentRun.unshift(traceMw.agentMiddleware.beforeAgentRun);
  hooks.beforeAddResponse.push(traceMw.agentMiddleware.beforeAddResponse);
  hooks.afterAgentRun.push(traceMw.agentMiddleware.afterAgentRun);
  toolMiddlewares.push(traceMw.toolMiddleware);  // innermost onion layer
}
```

### 10.2 Sub-agent trace linking

`ContextManager.getContext()` rebuilds `metadata` from scratch on every call, so `_parentTraceRunId` must be injected via `ContextManager`'s constructor. We add an optional `initialMetadata` parameter:

```typescript
// src/agent/context.ts — ContextManager constructor
constructor(options: {
  tokenLimit: number;
  defaultSystemPrompt?: string;
  initialMetadata?: Record<string, unknown>;  // NEW
}) {
  this.initialMetadata = options.initialMetadata ?? {};
}

// getContext merges initialMetadata into the metadata object
getContext(config: AgentConfig): AgentContext {
  return {
    ...,
    metadata: {
      ...this.initialMetadata,  // injected first, overridable by computed fields
      todo: { ... },
    },
  };
}
```

Then in `SubAgentTool.execute()`, the parent's trace run ID is read from the parent context and injected:

```typescript
// Inside SubAgentTool.execute():
const parentTraceRunId =
  (ctx.agentContext.metadata._traceBuffer as TraceBuffer | undefined)?.runId;

const subContextManager = new ContextManager({
  tokenLimit,
  defaultSystemPrompt: systemPrompt,
  ...(parentTraceRunId ? { initialMetadata: { _parentTraceRunId: parentTraceRunId } } : {}),
});
```

This is a minimal change to `ContextManager` (one optional field) and `SubAgentTool` (one read + pass-through). The `TraceAgentMiddleware.beforeAgentRun` already reads `context.metadata._parentTraceRunId` to set up the parent-child link.

---

## 11. Testing Strategy

```
tests/trace/
  trace-buffer.test.ts         # create, recordTurn, recordToolExec, finalize, summary computation
  store.test.ts                # appendTurn, finalize, retention enforcement, listBySession, get reconstruction
  redactor.test.ts             # default patterns, custom redactor, path truncation
  nudge-engine.test.ts         # tick trigger, fingerprint dedup, persist/load cycle, reset on restart
  tool-middleware.test.ts      # records success, records error, no-op without buffer
  agent-middleware.test.ts     # beforeAgentRun init, beforeAddResponse record, afterAgentRun finalize
  sub-agent-isolation.test.ts  # concurrent sub-agents get independent buffers; parentRunId linkage
  crash-recovery.test.ts       # partial NDJSON file is readable; only last turn lost
```

---

## 12. Phase 2: Background Review

After Phase 1 is stable:

1. **Review Prompt construction** — assemble trace summaries into structured review prompts keyed by `NudgeResult.trigger`
2. **Background Agent fork** — spawn a lightweight Agent with only `memory` + `skill_manage` tools, max 8 iterations
3. **Output routing** — writes to `~/.my-agent/memory/` and `~/.my-agent/skills/auto/`
4. **User notification** — compact summary surfaced after review completes

---

## 13. Architecture Compliance (Constitution §A–I)

- **§A**: No direct instantiation in `bin/*`. Integration via `createAgentRuntime()`.
- **§B**: No `any` types. `metadata._traceBuffer` typed as `TraceBuffer | undefined`.
- **§C**: Uses 3 of 6 existing hook points. No new hooks.
- **§D**: ToolDispatcher unchanged — TraceToolMiddleware is a consumer.
- **§E**: No new `syncTodoFromContext` calls.
- **§F**: All types fully used. `nanoid` is already in `package.json` dependencies.
- **§G**: Each file < 100 lines.
- **§H**: New public APIs have unit tests (see §11).
- **§I**: `debugLog` instead of `console.log`. No `@ts-ignore`.
