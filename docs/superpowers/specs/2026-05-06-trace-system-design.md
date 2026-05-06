# Trace System Design — Middleware-Based Agent Loop Recording for Self-Evolution

**Date**: 2026-05-06
**Status**: Draft
**Reference**: Hermes Agent (NousResearch/hermes-agent) architecture audit

---

## 1. Motivation

The agent currently has no structured recording of its execution — what it did, why it succeeded or failed, what patterns emerged. The Memory system captures extracted facts from conversation, but not the *process*: which tools were called, what thinking led to decisions, where errors occurred, and how many turns a task required.

This trace system provides the foundational recording layer. On top of it, a Nudge Engine periodically triggers review of accumulated traces to produce user-level skills and memories — enabling self-evolution without polluting the project workspace.

## 2. Design Principles

- **Leverage existing hooks** — no new hook points (constitution §C). Use `beforeAddResponse` + `afterAgentRun` + `ToolMiddleware`.

> **Why `beforeAddResponse` instead of `afterModel`**: In `agent-loop.ts`, `context.response` is set AFTER `afterModel` runs but BEFORE `beforeAddResponse`. The LLM response (thinking, content, tool_calls, usage) is only available in `beforeAddResponse`.
- **Follow existing patterns** — same file-based storage as MemoryStore, same middleware registration as PermissionMiddleware.
- **User vs project separation** — auto-generated artifacts (skills from traces) go to `~/.my-agent/skills/`, never to the project `skills/` directory.
- **Phase 1: record. Phase 2: review.** Ship recording first, then add background review agent.
- **OpenTelemetry-ready** — TraceStore interface accepts an optional exporter, but Phase 1 writes JSON files locally.

## 3. Architecture

```
Agent Loop
  │
  ├─ beforeModel        → (no trace work needed)
  ├─ beforeAddResponse → TraceAgentMiddleware: records LLM response + usage per turn
  │
  ├─ ToolDispatcher
  │    └─ TraceToolMiddleware (innermost): records each tool execution
  │
  └─ afterAgentRun  → TraceAgentMiddleware:
                         1. finalize TraceRun
                         2. persist via TraceStore
                         3. tick NudgeEngine counters
                         4. emit NudgeResult if threshold reached
```

### 3.1 Component Diagram

```
┌──────────────────────────────────────────────────────────┐
│                      Agent Loop                           │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐ │
│  │beforeModel│  │beforeAddResp│  │ Tools │  │afterAgentRun│ │
│  └─────────┘  └─────┬──────┘  └────┬─────┘  └─────┬─────┘ │
│                     │              │               │       │
│                     ▼              ▼               ▼       │
│            ┌──────────────┐ ┌────────────┐ ┌─────────────┐ │
│            │TraceAgent    │ │TraceTool   │ │TraceAgent    │ │
│            │Middleware    │ │Middleware  │ │Middleware    │ │
│            │(beforeAddResp)│ │            │ │(afterAgentRun)│ │
│            └─────┬──────┘ └─────┬──────┘ └──────┬──────┘ │
│                  │              │                │        │
│                  └──────────────┼────────────────┘        │
│                                 │                         │
│                          ┌──────▼──────┐                  │
│                          │ TraceBuffer │ (in-memory)      │
│                          └──────┬──────┘                  │
│                                 │                         │
└─────────────────────────────────┼─────────────────────────┘
                                  │
                    ┌─────────────▼──────────────┐
                    │        TraceStore           │
                    │  ~/.my-agent/traces/        │
                    │                             │
                    │  save(trace) → trace.json    │
                    │  list(sessionId)            │
                    │  listRecent(limit)          │
                    │  [future: export(exporter)] │
                    └─────────────┬──────────────┘
                                  │
                    ┌─────────────▼──────────────┐
                    │      NudgeEngine            │
                    │                             │
                    │  turnsSinceReview: number   │
                    │  reviewInterval: 10         │
                    │                             │
                    │  tick(trace) → NudgeResult? │
                    └─────────────────────────────┘
```

## 4. Data Model

### 4.1 TraceRun — one per agent.run() call

```typescript
interface TraceRun {
  id: string;              // nanoid
  sessionId: string;       // links runs within a session
  startTime: number;       // Date.now()
  endTime: number;
  model: string;
  turns: TraceTurn[];
  summary: TraceSummary;
}

interface TraceTurn {
  turnIndex: number;
  userMessage?: string;    // the user message that drove this turn
  model: {
    thinking?: string;
    text: string;
    toolCalls: Array<{
      name: string;
      arguments: Record<string, unknown>;
    }>;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };
  toolExecutions: Array<{
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

interface TraceSummary {
  totalTurns: number;
  totalToolCalls: number;
  totalErrors: number;
  totalTokens: { prompt: number; completion: number; total: number };
  outcome: "completed" | "error" | "max_turns" | "aborted";
  error?: string;
}
```

### 4.2 NudgeResult

```typescript
interface NudgeResult {
  trigger: "memory_review" | "skill_review" | "combined_review";
  traceRunId: string;
  sessionId: string;
  reason: string;          // human-readable, e.g. "5 tool errors in 3 turns"
}
```

## 5. Storage

### 5.1 Directory Layout

```
~/.my-agent/
  traces/
    {sessionId}/
      {runId}.json          # single run trace
  skills/                   # user-level, auto-generated
    {skill-name}/
      SKILL.md
```

### 5.2 TraceStore Interface

```typescript
interface TraceStore {
  save(trace: TraceRun): Promise<void>;
  get(runId: string): Promise<TraceRun | null>;
  listBySession(sessionId: string, limit?: number): Promise<TraceRun[]>;
  listRecent(limit?: number): Promise<TraceRun[]>;
  // OpenTelemetry extension point (future)
  export?(exporter: TraceExporter): Promise<void>;
}
```

- Files stored as JSON, one file per run.
- Auto-cleanup: retains last 100 runs. Deletes oldest when limit exceeded.
- No sensitive data: does NOT record full message content or tool argument values.

## 6. Middleware Details

### 6.1 TraceToolMiddleware

Registered in the ToolDispatcher middleware chain, **innermost** — wraps actual tool execution.

```
Registration order: permission → read-cache → trace → tool.execute
```

```typescript
class TraceToolMiddleware implements ToolMiddleware {
  name = "trace";

  constructor(private buffer: TraceBuffer) {}

  async handle(toolCall, ctx, next) {
    const start = Date.now();
    try {
      const result = await next();
      this.buffer.recordToolExecution({
        toolName: toolCall.name,
        success: true,
        durationMs: Date.now() - start,
      });
      return result;
    } catch (error) {
      this.buffer.recordToolExecution({
        toolName: toolCall.name,
        success: false,
        durationMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error; // propagate
    }
  }
}
```

### 6.2 TraceAgentMiddleware

Uses two hook slots:

**beforeAddResponse** — records the LLM response for the current turn (response is available at this point):

```typescript
beforeAddResponse: async (context, next) => {
  const ctx = await next();
  if (ctx.response) {
    this.buffer.recordTurn({
      thinking: extractThinking(ctx.response.blocks),
      text: ctx.response.content,
      toolCalls: ctx.response.tool_calls ?? [],
      usage: ctx.response.usage,
    });
  }
  return ctx;
}
```

**afterAgentRun** — finalizes, persists, and runs nudge check:

```typescript
afterAgentRun: async (context, next) => {
  const ctx = await next();

  const trace = this.buffer.finalize();
  await this.store.save(trace);

  const nudgeResult = this.nudgeEngine.tick(trace);
  if (nudgeResult) {
    // Phase 1: log the nudge via debugLog + write to trace metadata
    // Phase 2: trigger background review
    debugLog(`[trace] Nudge triggered: ${nudgeResult.reason}`);
  }

  return ctx;
}
```

### 6.3 TraceBuffer — shared state

Single instance injected into both middlewares:

```typescript
class TraceBuffer {
  private turns: PartialTraceTurn[] = [];
  private startTime: number;
  readonly sessionId: string;
  readonly runId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.runId = nanoid();
    this.startTime = Date.now();
  }

  recordTurn(turn: PartialTraceTurn): void { /* append */ }
  recordToolExecution(exec: TraceToolExecution): void { /* append to current turn */ }
  finalize(): TraceRun { /* assemble + return */ }
}
```

## 7. Nudge Engine

### 7.1 Counter Model (mirrors Hermes)

Two independent counters, maintained per-session:

```typescript
class NudgeEngine {
  private turnsSinceReview = 0;   // per user turn
  private reviewInterval: number; // default 10, from settings

  tick(trace: TraceRun): NudgeResult | null {
    this.turnsSinceReview += trace.summary.totalTurns;

    if (this.turnsSinceReview < this.reviewInterval) {
      return null;
    }

    this.turnsSinceReview = 0;

    // Priority: errors → complex tasks → periodic
    const reason = this.buildReason(trace);
    return {
      trigger: this.selectTrigger(trace),
      traceRunId: trace.id,
      sessionId: trace.sessionId,
      reason,
    };
  }

  private buildReason(trace: TraceRun): string {
    if (trace.summary.totalErrors > 0) {
      return `${trace.summary.totalErrors} tool errors across ${trace.summary.totalTurns} turns — review for improvement opportunities`;
    }
    if (trace.summary.totalTurns >= 5) {
      return `${trace.summary.totalTurns}-turn task completed — candidate for skill extraction`;
    }
    return `Periodic review after ${this.reviewInterval} accumulated turns`;
  }

  private selectTrigger(trace: TraceRun): NudgeResult["trigger"] {
    if (trace.summary.totalErrors > 0 && trace.summary.totalTurns >= 5) {
      return "combined_review";
    }
    if (trace.summary.totalErrors > 0) return "memory_review";
    return "skill_review";
  }
}
```

### 7.2 Review Prompt (Phase 2)

Modeled on Hermes' approach — a natural-language instruction, not a rule engine.

When Phase 2 activates, the NudgeEngine will construct a review prompt from the accumulated traces and dispatch it to the existing Memory/Skill extraction pipeline. The review agent reads trace turns, identifies patterns, and writes to `~/.my-agent/memory/` and `~/.my-agent/skills/`.

## 8. Configuration

Added to `settings.json` under a `trace` key:

```json
{
  "trace": {
    "enabled": true,
    "maxTraces": 100,
    "nudge": {
      "enabled": true,
      "reviewInterval": 10
    }
  }
}
```

## 9. File Structure

```
src/trace/
  types.ts              # TraceRun, TraceTurn, TraceSummary, etc.
  trace-buffer.ts       # In-memory buffer for a single run
  store.ts              # TraceStore — file persistence
  tool-middleware.ts    # TraceToolMiddleware
  agent-middleware.ts   # TraceAgentMiddleware
  nudge-engine.ts       # Counter + trigger logic
  index.ts              # public exports
```

Each file under 100 lines, all follow existing conventions (`debugLog`, no `any`, named constants).

## 10. Integration Points

- **In `createAgentRuntime()`** (`src/runtime.ts`): wire TraceToolMiddleware into the ToolDispatcher middleware list, TraceAgentMiddleware into AgentHooks.
- **In `AgentHooks`**: populate `beforeAddResponse` and `afterAgentRun` arrays.
- **With existing Memory system**: NudgeEngine's output feeds into MemoryExtractor in Phase 2.
- **With existing Skill system**: NudgeEngine can trigger skill creation in `~/.my-agent/skills/` in Phase 2.

## 11. Testing Strategy

- `tests/trace/trace-buffer.test.ts` — unit test buffer record + finalize
- `tests/trace/store.test.ts` — unit test save/get/list/cleanup
- `tests/trace/nudge-engine.test.ts` — unit test counter + trigger conditions
- `tests/trace/tool-middleware.test.ts` — integration test with mock tool
- `tests/trace/agent-middleware.test.ts` — integration test with mock agent context

## 12. Phase 2: Background Review

After Phase 1 is stable, Phase 2 adds:

1. **Review Prompt construction** — assemble trace summaries into a structured review prompt
2. **Background Agent fork** — spawn a lightweight Agent instance with only `memory` + `skill_manage` tools
3. **Output routing** — review results write to user-level stores only (`~/.my-agent/`)
4. **User notification** — compact summary surfaced via `_safe_print` (like Hermes' "💾 Self-improvement review: ...")

## 13. Architecture Compliance (Constitution §A–I)

- **§A**: No direct instantiation in `bin/*`. Integration goes through `createAgentRuntime()`.
- **§B**: No `any` types. All interfaces fully typed.
- **§C**: Uses existing 6 hook points only. No new hooks.
- **§D**: ToolDispatcher unchanged — TraceToolMiddleware is a consumer, not a modifier.
- **§E**: No new `syncTodoFromContext` calls.
- **§F**: All types fully used. Dead code not introduced.
- **§G**: Files < 400 lines, functions < 80 lines.
- **§H**: New public APIs have unit tests.
- **§I**: `debugLog` instead of `console.log`. No `@ts-ignore`.
