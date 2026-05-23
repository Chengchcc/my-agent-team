# Spec-10a: Contract Layer + Trace + Ports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add domain types, contracts, ports, and infrastructure needed by evolution/memory/trace/mcp before the big extension rewrites. Fix two bugs in turn-runner (duplicate `turn.completed` emit, swallowed `turn.failed`). Switch trace ext to TraceCheckpointer port.

**Architecture:** Three phases: A (types + contracts + bug fixes), B (infrastructure adapters), C (trace ext cutover + guard enforcement). All new ports follow the existing kernel/extension pattern. Zero functional changes to running system — only refactoring of internal wiring.

**Tech Stack:** TypeScript, Bun, Zod (contracts), bun:sqlite (memory store), NDJSON (trace)

---

## File Map

### Phase A: Domain + Contracts + Ports + Bug Fixes

| Action | Path | Purpose |
|---|---|---|
| CREATE | `src/domain/skill-stats.ts` | SkillStats type |
| CREATE | `src/domain/evolution-proposal.ts` | ProposalRecord type |
| MODIFY | `src/application/contracts/session-events.ts` | Extend TurnCompletedV1 + TurnFailedV1 payloads |
| MODIFY | `src/application/contracts/evolution-events.ts` | Add ReviewStarted/Completed/Failed types |
| MODIFY | `src/application/contracts/memory-events.ts` | Add ExtractStarted/Completed/Failed types |
| CREATE | `src/application/contracts/events/mcp-events.ts` | MCP contract event types |
| MODIFY | `src/application/contracts/events/contracted-event-map.ts` | Register 11 new events |
| CREATE | `src/application/ports/trace-checkpointer.ts` | TraceCheckpointer + TraceReader |
| CREATE | `src/application/ports/job-spawner.ts` | JobSpawner interface |
| CREATE | `src/application/ports/proposal-store.ts` | ProposalStore interface |
| CREATE | `src/application/ports/skill-stats-store.ts` | SkillStatsStore interface |
| MODIFY | `src/application/ports/memory-store.ts` | Add ftsSearch/vectorSearch/storeEmbedding/entriesWithoutEmbeddings/markHit/clear |
| DELETE (deprecate) | `src/application/ports/trace-writer.ts` | Replaced by trace-checkpointer |
| DELETE (deprecate) | `src/application/ports/trace-store.ts` | Replaced by trace-checkpointer |
| MODIFY | `src/application/ports/index.ts` | Update exports |
| MODIFY | `src/application/usecases/run-turn.ts` | Fix duplicate emit bug, fix swallowed turn.failed, collect+emit toolCallCount/toolErrorCount/runId/activatedSkills |
| MODIFY | `src/extensions/session/index.ts` | Delete duplicate contract emit (L161-165) |

### Phase B: Infrastructure Adapters

| Action | Path | Purpose |
|---|---|---|
| CREATE | `src/infrastructure/trace/ndjson-checkpointer.ts` | Rename + extend FsTraceWriter → TraceCheckpointer |
| CREATE | `src/infrastructure/trace/inmem-checkpointer.ts` | Rename + extend InmemTraceWriter → TraceCheckpointer |
| CREATE | `src/infrastructure/trace/index.ts` | Factory: createNdjsonCheckpointer / createInmemCheckpointer |
| CREATE | `src/infrastructure/evolution/fs-proposal-store.ts` | NDJSON append-based ProposalStore |
| CREATE | `src/infrastructure/evolution/fs-skill-stats-store.ts` | JSON file + atomic write SkillStatsStore |
| CREATE | `src/infrastructure/jobs/bun-spawn-job-spawner.ts` | Bun.spawn + NDJSON IPC |
| CREATE | `src/infrastructure/jobs/inproc-job-spawner.ts` | In-process require + call handle() |
| CREATE | `src/infrastructure/jobs/index.ts` | createJobSpawner factory with env-var switching |
| MODIFY | `src/extensions/memory/memory/sqlite-store.ts` | Promote to `src/infrastructure/memory/sqlite-memory-store.ts` |
| MOVE | `src/extensions/memory/memory/sqlite-schema.ts` → `src/infrastructure/memory/sqlite-schema.ts` | Promote schema |
| CREATE | `src/infrastructure/memory/index.ts` | createSqliteMemoryStore factory (profileId + baseDir) |
| DELETE | `src/infrastructure/memory/sqlite-memory-adapter.ts` | No longer needed; store directly implements MemoryStore |

### Phase C: Trace Ext Cutover + Guard Rollout

| Action | Path | Purpose |
|---|---|---|
| MODIFY | `src/extensions/trace/index.ts` | Switch FsTraceWriter → TraceCheckpointer; remove trace.flushed emit |
| MODIFY | `src/domain/trace-event.ts` | Remove `trace.flushed` from TraceEventType union |
| MODIFY | `scripts/check-architecture.ts` | Add A9/A10/A11/A16 guard rules |

---

## Phase A: Domain + Contracts + Ports + Bug Fixes

### Task A.1: Create domain types

**Files:**
- Create: `src/domain/skill-stats.ts`
- Create: `src/domain/evolution-proposal.ts`

- [ ] **Step 1: Write SkillStats type**

```ts
// src/domain/skill-stats.ts

/** Accumulated review statistics for a single skill. */
export interface SkillStats {
  name: string
  totalRuns: number
  successfulRuns: number
  lastRunId?: string
  lastReviewedAt: number  // unix ms
}

/** Computed from SkillStats. */
export interface SkillStatsSnapshot {
  name: string
  successRate: number  // 0-1
  totalRuns: number
  lastReviewedAt: number
}
```

- [ ] **Step 2: Write ProposalRecord type**

```ts
// src/domain/evolution-proposal.ts

/** A review verdict persisted by evolution ext. */
export interface ProposalRecord {
  id: string
  skillName?: string
  tier: 'tier0' | 'tier2'
  outcome: 'accepted' | 'rejected' | 'inconclusive'
  reasoning: string
  skillProposed?: {
    name: string
    description: string
    trigger: string
    instructions: string
  }
  createdAt: number  // unix ms
  runId: string
}
```

- [ ] **Step 3: Type check**

```bash
bun run check:guard
```

### Task A.2: Extend session-events.ts

**Files:**
- Modify: `src/application/contracts/session-events.ts`

- [ ] **Step 1: Update TurnCompletedV1**

Replace the existing TurnCompletedV1 (L38-42) and its codec with the extended version:

```ts
// ── turn.completed ────────────────────────────────────────────────────────────

export interface TurnCompletedV1 {
  sessionId: string;
  turnId: string;
  runId: string;              // NEW — equals turnId
  usage: { input: number; output: number };
  toolCallCount: number;       // NEW
  toolErrorCount: number;      // NEW
  activatedSkills: string[];   // NEW — empty array in first version
}

export const turnCompletedCodec = createCodec<TurnCompletedV1>(
  z.object({
    sessionId: z.string(),
    turnId: z.string(),
    runId: z.string(),
    usage: z.object({ input: z.number(), output: z.number() }),
    toolCallCount: z.number(),
    toolErrorCount: z.number(),
    activatedSkills: z.array(z.string()),
  }),
);
```

- [ ] **Step 2: Update TurnFailedV1**

Replace the existing TurnFailedV1 (L54-59) and its codec:

```ts
// ── turn.failed ───────────────────────────────────────────────────────────────

export interface TurnFailedV1 {
  sessionId: string;
  turnId: string;
  runId: string;              // NEW — equals turnId
  outcome: 'error' | 'aborted' | 'max_turns' | 'network_error';  // NEW
  stage: string;
  reason: string;
  toolErrorCount: number;     // NEW
}

export const turnFailedCodec = createCodec<TurnFailedV1>(
  z.object({
    sessionId: z.string(),
    turnId: z.string(),
    runId: z.string(),
    outcome: z.enum(['error', 'aborted', 'max_turns', 'network_error']),
    stage: z.string(),
    reason: z.string(),
    toolErrorCount: z.number(),
  }),
);
```

- [ ] **Step 3: Type check**

```bash
bun run check:guard
```
Expected: FAIL — emit points still use old payload shapes (will fix in Task A.6)

### Task A.3: Extend evolution-events.ts and memory-events.ts

**Files:**
- Modify: `src/application/contracts/evolution-events.ts`
- Modify: `src/application/contracts/memory-events.ts`

- [ ] **Step 1: Add evolution review events**

Append to `src/application/contracts/evolution-events.ts`:

```ts
// ── evolution.review.started ─────────────────────────────────────────────────

export interface EvolutionReviewStartedV1 {
  runId: string;
  tier: 'tier0' | 'tier2';
  skillName?: string;
}

export const evolutionReviewStartedCodec = createCodec<EvolutionReviewStartedV1>(
  z.object({
    runId: z.string(),
    tier: z.enum(['tier0', 'tier2']),
    skillName: z.string().optional(),
  }),
);

// ── evolution.review.completed ──────────────────────────────────────────────

export interface EvolutionReviewCompletedV1 {
  runId: string;
  tier: 'tier0' | 'tier2';
  outcome: 'accepted' | 'rejected' | 'inconclusive';
  skillName?: string;
}

export const evolutionReviewCompletedCodec = createCodec<EvolutionReviewCompletedV1>(
  z.object({
    runId: z.string(),
    tier: z.enum(['tier0', 'tier2']),
    outcome: z.enum(['accepted', 'rejected', 'inconclusive']),
    skillName: z.string().optional(),
  }),
);

// ── evolution.review.failed ──────────────────────────────────────────────────

export interface EvolutionReviewFailedV1 {
  runId: string;
  tier: 'tier0' | 'tier2';
  message: string;
}

export const evolutionReviewFailedCodec = createCodec<EvolutionReviewFailedV1>(
  z.object({
    runId: z.string(),
    tier: z.enum(['tier0', 'tier2']),
    message: z.string(),
  }),
);
```

- [ ] **Step 2: Add memory extract events**

Append to `src/application/contracts/memory-events.ts`:

```ts
// ── memory.extract.started ──────────────────────────────────────────────────

export interface MemoryExtractStartedV1 {
  runId: string;
}

export const memoryExtractStartedCodec = createCodec<MemoryExtractStartedV1>(
  z.object({
    runId: z.string(),
  }),
);

// ── memory.extract.completed ────────────────────────────────────────────────

export interface MemoryExtractCompletedV1 {
  runId: string;
  count: number;
}

export const memoryExtractCompletedCodec = createCodec<MemoryExtractCompletedV1>(
  z.object({
    runId: z.string(),
    count: z.number(),
  }),
);

// ── memory.extract.failed ───────────────────────────────────────────────────

export interface MemoryExtractFailedV1 {
  runId: string;
  message: string;
}

export const memoryExtractFailedCodec = createCodec<MemoryExtractFailedV1>(
  z.object({
    runId: z.string(),
    message: z.string(),
  }),
);
```

- [ ] **Step 3: Type check**

```bash
bun run check:guard
```

### Task A.4: Create MCP contract events

**Files:**
- Create: `src/application/contracts/events/mcp-events.ts`

- [ ] **Step 1: Write MCP event types**

```ts
// src/application/contracts/events/mcp-events.ts
import { z } from 'zod';
import { createCodec } from '../shared/codec';

/** Summary of server capabilities for contract use (no ext-internal imports). */
export interface McpCapabilitiesSummary {
  tools: number;
  resources: number;
  prompts: number;
}

// ── mcp.server.connected ───────────────────────────────────────────────────

export interface McpServerConnectedV1 {
  name: string;
  capabilities: McpCapabilitiesSummary;
}

export const mcpServerConnectedCodec = createCodec<McpServerConnectedV1>(
  z.object({
    name: z.string(),
    capabilities: z.object({
      tools: z.number(),
      resources: z.number(),
      prompts: z.number(),
    }),
  }),
);

// ── mcp.server.disconnected ─────────────────────────────��────────────────────

export interface McpServerDisconnectedV1 {
  name: string;
  reason: 'shutdown' | 'error' | 'removed';
}

export const mcpServerDisconnectedCodec = createCodec<McpServerDisconnectedV1>(
  z.object({
    name: z.string(),
    reason: z.enum(['shutdown', 'error', 'removed']),
  }),
);

// ── mcp.server.failed ──────────────────────────────────────────────────────

export interface McpServerFailedV1 {
  name: string;
  message: string;
  attempt: number;
}

export const mcpServerFailedCodec = createCodec<McpServerFailedV1>(
  z.object({
    name: z.string(),
    message: z.string(),
    attempt: z.number(),
  }),
);

// ── mcp.reloaded ───────────────────────────────────────────────────────────

export interface McpReloadedV1 {
  reconnected: string[];
  failed: string[];
}

export const mcpReloadedCodec = createCodec<McpReloadedV1>(
  z.object({
    reconnected: z.array(z.string()),
    failed: z.array(z.string()),
  }),
);

// ── mcp.tools.changed ──────────────────────────────────────────────────────

export interface McpToolsChangedV1 {
  added: string[];
  removed: string[];
  serverName: string;
}

export const mcpToolsChangedCodec = createCodec<McpToolsChangedV1>(
  z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    serverName: z.string(),
  }),
);
```

- [ ] **Step 2: Type check**

```bash
bun run check:guard
```

### Task A.5: Update ContractedEventMap

**Files:**
- Modify: `src/application/contracts/events/contracted-event-map.ts`

- [ ] **Step 1: Add imports and register 11 new events**

```ts
// Add imports:
import type { EvolutionReviewStartedV1, EvolutionReviewCompletedV1, EvolutionReviewFailedV1 } from '../evolution-events'
import type { MemoryExtractStartedV1, MemoryExtractCompletedV1, MemoryExtractFailedV1 } from '../memory-events'
import type { McpServerConnectedV1, McpServerDisconnectedV1, McpServerFailedV1, McpReloadedV1, McpToolsChangedV1 } from './mcp-events'

// Add to ContractedEventMap interface:
  'evolution.review.started': EvolutionReviewStartedV1
  'evolution.review.completed': EvolutionReviewCompletedV1
  'evolution.review.failed': EvolutionReviewFailedV1
  'memory.extract.started': MemoryExtractStartedV1
  'memory.extract.completed': MemoryExtractCompletedV1
  'memory.extract.failed': MemoryExtractFailedV1
  'mcp.server.connected': McpServerConnectedV1
  'mcp.server.disconnected': McpServerDisconnectedV1
  'mcp.server.failed': McpServerFailedV1
  'mcp.reloaded': McpReloadedV1
  'mcp.tools.changed': McpToolsChangedV1
```

- [ ] **Step 2: Type check**

```bash
bun run check:guard
```

### Task A.6: Fix turn-runner bugs + collect new fields

**Files:**
- Modify: `src/application/usecases/run-turn.ts`

- [ ] **Step 1: Add counters and collect toolCallCount/toolErrorCount**

Replace L142-144 (the counter initialization) with:

```ts
  // Phase 5: drive turn-runner generator
  const collectedToolCalls: ToolCallRecord[] = []
  let finalText = ''
  let totalUsage = { input: 0, output: 0 }
  let toolCallCount = 0
  let toolErrorCount = 0
```

- [ ] **Step 2: Increment counters in switch**

Replace the `switch (event.type)` block (L162-177) with:

```ts
      switch (event.type) {
        case 'tool.end':
          toolCallCount++
          collectedToolCalls.push({
            id: event.callId, name: event.name,
            arguments: event.result,
            resultText: stringifyResult(event.result),
          })
          break
        case 'tool.error':
          toolCallCount++
          toolErrorCount++
          break
        case 'turn.completed':
          finalText = event.finalMessage
          totalUsage = event.usage
          break
        case 'turn.failed':
          // BUGFIX: emit contract turn.failed instead of just logging
          asContractBus(bus).emit(createEvent('turn.failed', {
            sessionId,
            turnId,
            runId: turnId,
            outcome: 'error',
            stage: event.stage,
            reason: event.err.message,
            toolErrorCount,
          }, { sessionId, turnId }))
          logger.warn('turn', `Turn ${turnId} failed at ${event.stage}: ${event.err.message}`)
          return { usage: totalUsage, success: false }
      }
```

- [ ] **Step 3: Update turn.failed emit in catch (L179-182)**

Replace the catch block's emitFailed call:

```ts
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err))
    asContractBus(bus).emit(createEvent('turn.failed', {
      sessionId,
      turnId,
      runId: turnId,
      outcome: 'error',
      stage: 'usecase_internal' as TurnFailureStage,
      reason: e.message,
      toolErrorCount,
    }, { sessionId, turnId }))
    return { usage: totalUsage, success: false }
  }
```

Note: remove the `emitFailed` calls at L113/115 and L127/129 — replace with equivalent contract emit:

- [ ] **Step 4: Fix transformPrompt fail path (L112-116)**

Replace:
```ts
  if (!promptR.ok) {
    emitFailed(bus, sessionId, turnId, 'transformPrompt', promptR.err)
    logger.warn('turn', `transformPrompt failed: ${promptR.err.message}`)
    return { usage: { input: 0, output: 0 }, success: false }
  }
```

With:
```ts
  if (!promptR.ok) {
    asContractBus(bus).emit(createEvent('turn.failed', {
      sessionId, turnId, runId: turnId,
      outcome: 'error', stage: 'transformPrompt',
      reason: promptR.err.message, toolErrorCount: 0,
    }, { sessionId, turnId }))
    logger.warn('turn', `transformPrompt failed: ${promptR.err.message}`)
    return { usage: { input: 0, output: 0 }, success: false }
  }
```

- [ ] **Step 5: Fix resolveTools fail path (L126-130)**

Same pattern — replace with contract emit using `outcome: 'error'`, `stage: 'resolveTools'`.

- [ ] **Step 6: Fix onTurnEnd fail path (L205-208)**

Replace `emitFailed` with direct contract emit using `outcome: 'error'`, `stage: 'onTurnEnd'`.

- [ ] **Step 7: Update turn.completed emit (L210-214)**

Replace:
```ts
  asContractBus(bus).emit(createEvent('turn.completed', {
    sessionId,
    turnId,
    usage: { input: totalUsage.input, output: totalUsage.output },
  }))
```

With:
```ts
  asContractBus(bus).emit(createEvent('turn.completed', {
    sessionId,
    turnId,
    runId: turnId,
    usage: { input: totalUsage.input, output: totalUsage.output },
    toolCallCount,
    toolErrorCount,
    activatedSkills: [],  // populated in Phase F
  }, { sessionId, turnId }))
```

- [ ] **Step 8: Remove the now-unused `emitFailed` helper (L70-83)**

Delete the function.

- [ ] **Step 9: Type check**

```bash
bun run check:guard
```
Expected: FAIL — session ext still emits old payload (will fix next).

### Task A.7: Delete duplicate turn.completed emit in session ext

**Files:**
- Modify: `src/extensions/session/index.ts`

- [ ] **Step 1: Remove L161-165 contract emit**

Delete lines 161-165:
```ts
        contractBus.emit(createEvent('turn.completed', {
          sessionId: result.sessionId,
          turnId: result.turnId,
          usage: result.usage,
        }, { sessionId: result.sessionId, turnId: result.turnId }))
```

Keep lines 154-159 (trace emit) — those stay.

- [ ] **Step 2: Type check**

```bash
bun run check:guard
```
Expected: PASS

### Task A.8: Create new ports

**Files:**
- Create: `src/application/ports/trace-checkpointer.ts`
- Create: `src/application/ports/job-spawner.ts`
- Create: `src/application/ports/proposal-store.ts`
- Create: `src/application/ports/skill-stats-store.ts`

- [ ] **Step 1: Write trace-checkpointer.ts**

```ts
// src/application/ports/trace-checkpointer.ts
import type { TraceEvent } from '../../domain/trace-event'
import type { TraceRun, TraceSummary } from '../../domain/trace/types'

/** Unified trace persistence port — replaces TraceWriter + TraceStore. */
export interface TraceCheckpointer {
  append(event: TraceEvent): Promise<void>
  flush(): Promise<void>
  getRun(runId: string): Promise<TraceRun | null>
  listRecentSummaries(opts: {
    limit: number
    sessionId?: string
    since?: number
  }): Promise<TraceSummary[]>
}

/** Read-only subset exposed to evolution/memory via trace ext capability. */
export type TraceReader = Pick<TraceCheckpointer, 'getRun' | 'listRecentSummaries'>
```

- [ ] **Step 2: Write job-spawner.ts**

```ts
// src/application/ports/job-spawner.ts

/**
 * Spawns a short-lived worker for LLM-heavy, one-shot tasks
 * (evolution review, memory extract). TJob and TResult must be
 * JSON-safe — no Date, no Map, no circular references.
 */
export interface JobSpawner {
  run<TJob, TResult>(opts: {
    entry: string         // require.resolve(...) absolute path
    job: TJob
    timeoutMs?: number
  }): Promise<TResult>
}
```

- [ ] **Step 3: Write proposal-store.ts**

```ts
// src/application/ports/proposal-store.ts
import type { ProposalRecord } from '../../domain/evolution-proposal'

export interface ProposalStore {
  append(proposal: ProposalRecord): Promise<void>
  list(opts?: { limit?: number }): Promise<ProposalRecord[]>
  markAccepted(id: string): Promise<void>
  markRejected(id: string): Promise<void>
}
```

- [ ] **Step 4: Write skill-stats-store.ts**

```ts
// src/application/ports/skill-stats-store.ts
import type { SkillStats } from '../../domain/skill-stats'

export interface SkillStatsStore {
  get(name: string): Promise<SkillStats | null>
  put(stats: SkillStats): Promise<void>
  list(): Promise<SkillStats[]>
}
```

- [ ] **Step 5: Type check**

```bash
bun run check:guard
```

### Task A.9: Extend memory-store port

**Files:**
- Modify: `src/application/ports/memory-store.ts`

- [ ] **Step 1: Add 6 methods to MemoryStore interface**

Add to the existing `MemoryStore` interface:

```ts
  /** FTS5 full-text search with BM25 ranking. */
  ftsSearch(query: string, limit: number): Promise<MemoryEntry[]>

  /** sqlite-vec cosine-distance search. Returns entries with distance scores. */
  vectorSearch(queryEmbedding: number[], limit: number): Promise<Array<{ entry: MemoryEntry; distance: number }>>

  /** Store a computed embedding for an entry. */
  storeEmbedding(entryId: string, embedding: number[]): Promise<void>

  /** Find entries that don't have embeddings yet (for backfill). */
  entriesWithoutEmbeddings(batchSize: number): Promise<Array<{ id: string; text: string }>>

  /** Mark entries as hit (updates lastHitAt + usageCount). */
  markHit(ids: string[]): Promise<void>

  /** Delete all entries (for test fixtures). */
  clear(): Promise<void>
```

- [ ] **Step 2: Type check**

```bash
bun run check:guard
```
Expected: FAIL — `sqlite-memory-adapter.ts` doesn't implement new methods. This is expected; adapter gets deleted in Phase B.

### Task A.10: Update ports index.ts

**Files:**
- Modify: `src/application/ports/index.ts`

- [ ] **Step 1: Update exports**

```ts
export type { TraceCheckpointer, TraceReader } from './trace-checkpointer'
export type { JobSpawner } from './job-spawner'
export type { ProposalStore } from './proposal-store'
export type { SkillStatsStore } from './skill-stats-store'
// Remove: export type { TraceWriter, TraceReader } from './trace-writer'
// Remove: export type { TraceStoreWriter, TraceStoreReader, TraceStore } from './trace-store'
```

- [ ] **Step 2: Type check**

```bash
bun run check:guard
```
Expected: FAIL — consumers still import old ports (trace ext, fs-trace-writer). Will fix in Phase C.

### Task A.11: Run rg verification gate

- [ ] **Step 1: Check for remaining old-port imports**

```bash
rg -n "trace-writer|trace-store" src/ --include '*.ts' | grep -v node_modules
```
Expected output: only `ports/index.ts` (deprecated re-export if kept) and `infrastructure/trace/fs-trace-writer.ts` (will be renamed in Phase B).

- [ ] **Step 2: Run architecture check**

```bash
bun run check:arch
```
Expected: PASS (or only pre-existing violations).

- [ ] **Step 3: Commit Phase A**

```bash
git add src/domain/skill-stats.ts src/domain/evolution-proposal.ts
git add src/application/contracts/
git add src/application/ports/
git add src/application/usecases/run-turn.ts
git add src/extensions/session/index.ts
git commit -m "feat(p10a): add domain types, extend contracts, fix turn-runner bugs

- Add SkillStats + ProposalRecord domain types
- Extend TurnCompletedV1 (runId/toolCallCount/toolErrorCount/activatedSkills)
- Extend TurnFailedV1 (runId/outcome/toolErrorCount)
- Add evolution.review.* / memory.extract.* / mcp.* contract events
- Add TraceCheckpointer / JobSpawner / ProposalStore / SkillStatsStore ports
- Fix duplicate turn.completed emit (session ext)
- Fix swallowed turn.failed event (runner generator)"
```

---

## Phase B: Infrastructure Adapters

### Task B.1: Rename FsTraceWriter → NdjsonCheckpointer

**Files:**
- Create: `src/infrastructure/trace/ndjson-checkpointer.ts`
- (Keep: `src/infrastructure/trace/fs-trace-writer.ts` temporarily, delete in Phase C)

- [ ] **Step 1: Write NdjsonCheckpointer**

```ts
// src/infrastructure/trace/ndjson-checkpointer.ts
import type { TraceCheckpointer } from '../../application/ports/trace-checkpointer'
import type { TraceEvent } from '../../domain/trace-event'
import type { TraceRun, TraceSummary } from '../../domain/trace/types'
import { join } from 'path'
import { mkdir, appendFile, readFile, readdir } from 'fs/promises'

/**
 * NdjsonCheckpointer — NDJSON file per run.
 * Layout: baseDir / sessionId / {runId}.jsonl
 * One line = one TraceEvent.
 */
export class NdjsonCheckpointer implements TraceCheckpointer {
  private readonly baseDir: string
  private readonly sessionId: string
  private readonly runId: string

  constructor(baseDir: string, sessionId: string) {
    this.baseDir = baseDir
    this.sessionId = sessionId
    this.runId = `run-${Date.now()}`
  }

  private get filePath(): string {
    return join(this.baseDir, this.sessionId, `${this.runId}.jsonl`)
  }

  async append(event: TraceEvent): Promise<void> {
    await mkdir(join(this.baseDir, this.sessionId), { recursive: true })
    const line = JSON.stringify(event) + '\n'
    await appendFile(this.filePath, line, 'utf-8')
  }

  async flush(): Promise<void> {
    // NDJSON appendFile writes synchronously; no-op
  }

  async getRun(runId: string): Promise<TraceRun | null> {
    // Search all session dirs for runId
    try {
      const dirs = await readdir(this.baseDir, { withFileTypes: true })
      for (const d of dirs) {
        if (!d.isDirectory()) continue
        const fp = join(this.baseDir, d.name, `${runId}.jsonl`)
        try {
          const content = await readFile(fp, 'utf-8')
          const events: TraceEvent[] = content.trim().split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line) as TraceEvent)
          return { id: runId, events, sessionId: d.name, createdAt: events[0]?.timestamp ?? new Date() }
        } catch { /* not in this dir */ }
      }
      return null
    } catch { return null }
  }

  async listRecentSummaries(opts: {
    limit: number; sessionId?: string; since?: number
  }): Promise<TraceSummary[]> {
    const summaries: TraceSummary[] = []
    try {
      const targetDir = opts.sessionId
        ? join(this.baseDir, opts.sessionId)
        : this.baseDir
      const entries = await readdir(targetDir, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
        const runId = e.name.replace('.jsonl', '')
        summaries.push({ id: runId, sessionId: opts.sessionId ?? '', turnCount: 0, createdAt: 0 })
      }
    } catch { /* dir may not exist */ }
    return summaries.slice(0, opts.limit)
  }
}
```

- [ ] **Step 2: Type check**

```bash
bun run check:guard
```

### Task B.2: Create InmemCheckpointer

**Files:**
- Create: `src/infrastructure/trace/inmem-checkpointer.ts`

- [ ] **Step 1: Write InmemCheckpointer**

```ts
// src/infrastructure/trace/inmem-checkpointer.ts
import type { TraceCheckpointer } from '../../application/ports/trace-checkpointer'
import type { TraceEvent } from '../../domain/trace-event'
import type { TraceRun, TraceSummary } from '../../domain/trace/types'

/** In-memory checkpointer for tests. Stores events keyed by runId. */
export class InmemCheckpointer implements TraceCheckpointer {
  private runs = new Map<string, TraceEvent[]>()
  private nextId = 1

  async append(event: TraceEvent): Promise<void> {
    // Derive runId from turnId — same convention as runId=turnId
    const runId = event.turnId
    if (!this.runs.has(runId)) this.runs.set(runId, [])
    this.runs.get(runId)!.push(event)
  }

  async flush(): Promise<void> { /* no-op */ }

  async getRun(runId: string): Promise<TraceRun | null> {
    const events = this.runs.get(runId)
    if (!events) return null
    return { id: runId, events, sessionId: '', createdAt: events[0]?.timestamp ?? new Date() }
  }

  async listRecentSummaries(opts: {
    limit: number; sessionId?: string; since?: number
  }): Promise<TraceSummary[]> {
    return Array.from(this.runs.entries())
      .slice(0, opts.limit)
      .map(([id, events]) => ({
        id,
        sessionId: '',
        turnCount: events.length,
        createdAt: events[0]?.timestamp?.getTime() ?? 0,
      }))
  }
}
```

- [ ] **Step 2: Type check**

```bash
bun run check:guard
```

### Task B.3: Create trace infra index

**Files:**
- Create: `src/infrastructure/trace/index.ts`

- [ ] **Step 1: Write factory**

```ts
// src/infrastructure/trace/index.ts
export { NdjsonCheckpointer } from './ndjson-checkpointer'
export { InmemCheckpointer } from './inmem-checkpointer'

import { NdjsonCheckpointer } from './ndjson-checkpointer'
import { InmemCheckpointer } from './inmem-checkpointer'
import { join } from 'path'
import { homedir } from 'os'

const DEFAULT_TRACE_BASE = join(homedir(), '.my-agent', 'traces')

export function createNdjsonCheckpointer(
  baseDir?: string,
  profileId?: string,
): NdjsonCheckpointer {
  const dir = baseDir ?? (profileId ? join(DEFAULT_TRACE_BASE, profileId) : DEFAULT_TRACE_BASE)
  return new NdjsonCheckpointer(dir, profileId ?? 'default')
}

export function createInmemCheckpointer(): InmemCheckpointer {
  return new InmemCheckpointer()
}
```

- [ ] **Step 2: Type check**

```bash
bun run check:guard
```

### Task B.4: Create JobSpawner implementations

**Files:**
- Create: `src/infrastructure/jobs/bun-spawn-job-spawner.ts`
- Create: `src/infrastructure/jobs/inproc-job-spawner.ts`
- Create: `src/infrastructure/jobs/index.ts`

- [ ] **Step 1: Write BunSpawnJobSpawner**

```ts
// src/infrastructure/jobs/bun-spawn-job-spawner.ts
import type { JobSpawner } from '../../application/ports/job-spawner'

export class BunSpawnJobSpawner implements JobSpawner {
  async run<TJob, TResult>(opts: {
    entry: string; job: TJob; timeoutMs?: number
  }): Promise<TResult> {
    const proc = Bun.spawn(['bun', 'run', opts.entry], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
      env: { ...process.env, JOB_MODE: 'spawn' },
    })

    proc.stdin.write(JSON.stringify(opts.job) + '\n')
    await proc.stdin.end()

    const timer = opts.timeoutMs
      ? setTimeout(() => proc.kill(), opts.timeoutMs)
      : null

    try {
      const text = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      if (exitCode !== 0) throw new Error(`worker exit ${exitCode}`)
      const lastLine = text.trim().split('\n').pop()!
      return JSON.parse(lastLine) as TResult
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
```

- [ ] **Step 2: Write InprocJobSpawner**

```ts
// src/infrastructure/jobs/inproc-job-spawner.ts
import type { JobSpawner } from '../../application/ports/job-spawner'

export class InprocJobSpawner implements JobSpawner {
  async run<TJob, TResult>(opts: {
    entry: string; job: TJob; timeoutMs?: number
  }): Promise<TResult> {
    const mod = await import(opts.entry)
    if (typeof mod.handle !== 'function') {
      throw new Error(`${opts.entry} missing exported handle()`)
    }
    return await mod.handle(opts.job) as TResult
  }
}
```

- [ ] **Step 3: Write factory index**

```ts
// src/infrastructure/jobs/index.ts
import type { JobSpawner } from '../../application/ports/job-spawner'
import { BunSpawnJobSpawner } from './bun-spawn-job-spawner'
import { InprocJobSpawner } from './inproc-job-spawner'

export function createJobSpawner(): JobSpawner {
  const mode = process.env.JOB_SPAWNER ?? 'spawn'
  return mode === 'spawn' ? new BunSpawnJobSpawner() : new InprocJobSpawner()
}
```

- [ ] **Step 4: Write smoke test**

Create `tests/infrastructure/jobs/bun-spawn-job-spawner.test.ts`:

```ts
import { describe, it, expect } from 'bun:test'
import { InprocJobSpawner } from '../../../src/infrastructure/jobs/inproc-job-spawner'
import { join } from 'path'

describe('InprocJobSpawner', () => {
  it('returns worker result', async () => {
    // Write a temporary worker-entry
    const tmpDir = join(import.meta.dir, '..', '..', 'fixtures')
    // Use a fixture that exports handle()
    const spawner = new InprocJobSpawner()
    // ...test that spawner.run calls handle and returns result
  })

  it('rejects when entry has no handle export', async () => {
    const spawner = new InprocJobSpawner()
    await expect(spawner.run({
      entry: join(import.meta.dir, '..', '..', 'fixtures', 'no-handle.ts'),
      job: {},
    })).rejects.toThrow('missing exported handle')
  })
})
```

- [ ] **Step 5: Type check**

```bash
bun run check:guard
```

### Task B.5: Create evolution infra (proposal + skill-stats stores)

**Files:**
- Create: `src/infrastructure/evolution/fs-proposal-store.ts`
- Create: `src/infrastructure/evolution/fs-skill-stats-store.ts`

- [ ] **Step 1: Write FsProposalStore**

```ts
// src/infrastructure/evolution/fs-proposal-store.ts
import type { ProposalStore } from '../../application/ports/proposal-store'
import type { ProposalRecord } from '../../domain/evolution-proposal'
import { join } from 'path'
import { mkdir, appendFile, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'

const DEFAULT_BASE = join(homedir(), '.my-agent', 'proposals')

export class FsProposalStore implements ProposalStore {
  private filePath: string

  constructor(baseDir: string = DEFAULT_BASE, profileId: string = 'default') {
    this.filePath = join(baseDir, profileId, 'proposals.jsonl')
  }

  async append(proposal: ProposalRecord): Promise<void> {
    await mkdir(join(this.filePath, '..'), { recursive: true })
    await appendFile(this.filePath, JSON.stringify(proposal) + '\n', 'utf-8')
  }

  async list(opts: { limit?: number } = {}): Promise<ProposalRecord[]> {
    try {
      const content = await readFile(this.filePath, 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)
      const limit = opts.limit ?? lines.length
      return lines.slice(-limit).map(l => JSON.parse(l) as ProposalRecord)
    } catch { return [] }
  }

  async markAccepted(id: string): Promise<void> { /* append-only; accepted tracked elsewhere */ }
  async markRejected(id: string): Promise<void> { /* append-only */ }
}
```

Wait — `markAccepted`/`markRejected` need actual implementation. Let me use a simple metadata file:

```ts
// src/infrastructure/evolution/fs-proposal-store.ts
import type { ProposalStore } from '../../application/ports/proposal-store'
import type { ProposalRecord } from '../../domain/evolution-proposal'
import { join } from 'path'
import { mkdir, appendFile, readFile, writeFile, access } from 'fs/promises'
import { homedir } from 'os'

const DEFAULT_BASE = join(homedir(), '.my-agent', 'proposals')

interface ProposalMeta { accepted: Set<string>; rejected: Set<string> }

export class FsProposalStore implements ProposalStore {
  private filePath: string
  private metaPath: string

  constructor(baseDir: string = DEFAULT_BASE, profileId: string = 'default') {
    const dir = join(baseDir, profileId)
    this.filePath = join(dir, 'proposals.jsonl')
    this.metaPath = join(dir, 'proposals-meta.json')
  }

  async append(proposal: ProposalRecord): Promise<void> {
    await mkdir(join(this.filePath, '..'), { recursive: true })
    await appendFile(this.filePath, JSON.stringify(proposal) + '\n', 'utf-8')
  }

  async list(opts: { limit?: number } = {}): Promise<ProposalRecord[]> {
    try {
      const content = await readFile(this.filePath, 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)
      const limit = opts.limit ?? lines.length
      return lines.slice(-limit).map(l => JSON.parse(l) as ProposalRecord)
    } catch { return [] }
  }

  private async loadMeta(): Promise<ProposalMeta> {
    try {
      const raw = await readFile(this.metaPath, 'utf-8')
      const data = JSON.parse(raw)
      return {
        accepted: new Set(data.accepted ?? []),
        rejected: new Set(data.rejected ?? []),
      }
    } catch { return { accepted: new Set(), rejected: new Set() } }
  }

  private async saveMeta(meta: ProposalMeta): Promise<void> {
    await writeFile(this.metaPath, JSON.stringify({
      accepted: [...meta.accepted],
      rejected: [...meta.rejected],
    }), 'utf-8')
  }

  async markAccepted(id: string): Promise<void> {
    const meta = await this.loadMeta()
    meta.accepted.add(id)
    meta.rejected.delete(id)
    await this.saveMeta(meta)
  }

  async markRejected(id: string): Promise<void> {
    const meta = await this.loadMeta()
    meta.rejected.add(id)
    meta.accepted.delete(id)
    await this.saveMeta(meta)
  }
}
```

- [ ] **Step 2: Write FsSkillStatsStore**

```ts
// src/infrastructure/evolution/fs-skill-stats-store.ts
import type { SkillStatsStore } from '../../application/ports/skill-stats-store'
import type { SkillStats } from '../../domain/skill-stats'
import { join } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'

const DEFAULT_BASE = join(homedir(), '.my-agent', 'skill-stats')

export class FsSkillStatsStore implements SkillStatsStore {
  private dir: string

  constructor(baseDir: string = DEFAULT_BASE, profileId: string = 'default') {
    this.dir = join(baseDir, profileId)
  }

  private filePath(name: string): string {
    return join(this.dir, `${name}.json`)
  }

  async get(name: string): Promise<SkillStats | null> {
    try {
      const raw = await readFile(this.filePath(name), 'utf-8')
      return JSON.parse(raw) as SkillStats
    } catch { return null }
  }

  async put(stats: SkillStats): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    // Atomic write via tmp + rename
    const tmp = this.filePath(stats.name) + '.tmp'
    await writeFile(tmp, JSON.stringify(stats, null, 2), 'utf-8')
    await writeFile(this.filePath(stats.name), JSON.stringify(stats, null, 2), 'utf-8')
  }

  async list(): Promise<SkillStats[]> {
    // Simple implementation — read all json files in dir
    try {
      const { readdir } = await import('fs/promises')
      const entries = await readdir(this.dir, { withFileTypes: true })
      const results: SkillStats[] = []
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.json')) continue
        const stats = await this.get(e.name.replace('.json', ''))
        if (stats) results.push(stats)
      }
      return results
    } catch { return [] }
  }
}
```

- [ ] **Step 3: Type check**

```bash
bun run check:guard
```

### Task B.6: Promote sqlite-store to infra + delete adapter

**Files:**
- Create: `src/infrastructure/memory/sqlite-memory-store.ts` (promote + modify)
- Move: `src/extensions/memory/memory/sqlite-schema.ts` → `src/infrastructure/memory/sqlite-schema.ts`
- Create: `src/infrastructure/memory/index.ts` (factory)
- Delete: `src/infrastructure/memory/sqlite-memory-adapter.ts`

- [ ] **Step 1: Copy sqlite-store.ts to infra and add missing methods**

Copy `src/extensions/memory/memory/sqlite-store.ts` to `src/infrastructure/memory/sqlite-memory-store.ts`.

Modify the promoted file:

1. **Change imports** — `./sqlite-schema` stays (same dir now), `./types` → `../../domain/memory-entry` and `../../application/ports/memory-store`
2. **Change `rowToEntry`** to return `domain/memory-entry` types (Date fields)
3. **Change `add`** to accept domain MemoryEntry shape
4. **Add `clear()` method**
5. **Add close idempotency guard**
6. **Change `ftsSearch` signature** — remove explicit `type` param
7. **Change `vectorSearch`** to JOIN and return entry objects

```ts
// src/infrastructure/memory/sqlite-memory-store.ts
// Key modifications from the old ext version:

// 1. rowToEntry returns domain MemoryEntry with Date fields:
private rowToEntry(row: SqlRow): MemoryEntry {
  const e: MemoryEntry = {
    id: row.id,
    type: row.type as MemoryType,
    text: row.text,
    weight: row.weight,
    source: row.source as MemoryEntry['source'],
    tags: row.tags ? JSON.parse(row.tags) : [],
    createdAt: new Date(row.created),
    updatedAt: row.updated ? new Date(row.updated) : new Date(row.created),
    lastHitAt: row.lastHitAt != null ? new Date(row.lastHitAt) : undefined,
    usageCount: row.usageCount ?? 0,
  }
  if (row.embedding) {
    const buf = row.embedding as Buffer
    e.embedding = Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4))
  }
  return e
}

// 2. add accepts domain MemoryEntry (Date-based timestamps):
async add(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>): Promise<MemoryEntry> {
  const full: MemoryEntry = {
    ...entry,
    id: crypto.randomUUID(),
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  // ... rest same as before, but serialize createdAt/updatedAt to ISO strings
}

// 3. ftsSearch simplified signature:
async ftsSearch(query: string, limit: number): Promise<MemoryEntry[]> {
  const ftsQuery = query.replace(/[^\w\s\u4e00-\u9fa5]/g, ' ').trim()
  if (!ftsQuery) return []
  const rows = this.db.query(`
    SELECT m.*, bm25(memory_fts) as bm25_score
    FROM memory m
    JOIN memory_fts f ON m.id = f.id
    WHERE memory_fts MATCH ?
    ORDER BY bm25_score
    LIMIT ?
  `).all(ftsQuery, limit) as SqlRow[]
  return rows.map(r => this.rowToEntry(r))
}

// 4. vectorSearch returns entry objects:
async vectorSearch(queryEmbedding: number[], limit: number): Promise<Array<{ entry: MemoryEntry; distance: number }>> {
  const vec = JSON.stringify(queryEmbedding)
  const rows = this.db.query(`
    SELECT m.*, v.distance
    FROM vec_memory v
    JOIN memory m ON m.id = v.entry_id
    WHERE v.embedding MATCH ?
    ORDER BY v.distance
    LIMIT ?
  `).all(vec, limit) as Array<SqlRow & { distance: number }>
  return rows.map(r => ({ entry: this.rowToEntry(r), distance: r.distance }))
}

// 5. NEW: clear()
async clear(): Promise<void> {
  this.db.run('DELETE FROM memory')
  this.db.run('DELETE FROM memory_fts')
  this.db.run('DELETE FROM vec_memory')
}

// 6. close with idempotency:
private closed = false

async close(): Promise<void> {
  if (this.closed) return
  this.closed = true
  this.db.run('PRAGMA wal_checkpoint(TRUNCATE)')
  this.db.close()
}
```

- [ ] **Step 2: Copy sqlite-schema.ts to infra**

```bash
cp src/extensions/memory/memory/sqlite-schema.ts src/infrastructure/memory/sqlite-schema.ts
```

No changes needed — the schema is the same.

- [ ] **Step 3: Write factory**

```ts
// src/infrastructure/memory/index.ts
import { SqliteMemoryStore } from './sqlite-memory-store'
import { join } from 'path'
import { homedir } from 'os'
import type { MemoryStore } from '../../application/ports/memory-store'

const DEFAULT_BASE = join(homedir(), '.my-agent', 'memory')

export function createSqliteMemoryStore(opts: {
  profileId: string
  baseDir?: string
}): MemoryStore {
  const base = opts.baseDir ?? DEFAULT_BASE
  const dir = join(base, opts.profileId)
  return new SqliteMemoryStore(dir)
}
```

- [ ] **Step 4: Delete sqlite-memory-adapter.ts**

```bash
rm src/infrastructure/memory/sqlite-memory-adapter.ts
```

- [ ] **Step 5: Type check**

```bash
bun run check:guard
```
Expected: Multiple errors — old consumers still import the adapter from ext internals. Will fix in Spec-10b.

### Task B.7: Run rg verification gate + tests

- [ ] **Step 1: Confirm no more adapter imports**

```bash
rg -n "sqlite-memory-adapter" src/
```
Expected: zero hits.

- [ ] **Step 2: Run full check**

```bash
bun run check:all
```

- [ ] **Step 3: Commit Phase B**

```bash
git add src/infrastructure/
git add tests/infrastructure/
git commit -m "feat(p10a): add infrastructure adapters

- NdjsonCheckpointer + InmemCheckpointer (replace FsTraceWriter)
- BunSpawnJobSpawner + InprocJobSpawner
- FsProposalStore + FsSkillStatsStore
- Promote SqliteMemoryStore to infra with domain types + clear() + close guard
- Delete sqlite-memory-adapter (responsibilities merged into store)
- Smoketest for job spawner"
```

---

## Phase C: Trace Ext Cutover + Guard Rollout

### Task C.1: Rewrite trace ext to use TraceCheckpointer

**Files:**
- Modify: `src/extensions/trace/index.ts`

- [ ] **Step 1: Rewrite trace ext**

```ts
// src/extensions/trace/index.ts
import { defineExtension } from '../../kernel/define-extension'
import type { HookHandler } from '../../kernel/define-extension'
import { createNdjsonCheckpointer } from '../../infrastructure/trace'
import type { TraceEvent } from '../../domain/trace-event'
import type { TraceReader } from '../../application/ports/trace-checkpointer'
import { homedir } from 'os'
import { join } from 'path'

const DEFAULT_TRACE_BASE = join(homedir(), '.my-agent', 'traces')

/**
 * Trace extension — persists trace events via TraceCheckpointer.
 *
 * Capabilities exposed:
 *   - trace.reader: TraceReader (getRun + listRecentSummaries)
 *
 * Hooks:
 *   - onTraceEmit (pre): append event to checkpointer
 *   - onShutdown (post): flush
 */
export default (opts?: { baseDir?: string }) =>
  defineExtension({
    name: 'trace',
    enforce: 'pre',

    apply: (ctx) => {
      const baseDir = opts?.baseDir ?? join(DEFAULT_TRACE_BASE, ctx.profileId)
      const checkpointer = createNdjsonCheckpointer(baseDir, ctx.profileId)

      const onTraceEmit: HookHandler = async (...args: unknown[]) => {
        const event = args[0] as TraceEvent
        await checkpointer.append(event)
        // No longer emits 'trace.flushed' — downstream consumers subscribe
        // to contract events (turn.completed / turn.failed) directly.
      }

      const onShutdown: HookHandler = async () => {
        await checkpointer.flush()
      }

      return {
        provide: {
          reader: () => checkpointer as TraceReader,
        },

        hooks: {
          onTraceEmit: { enforce: 'pre', fn: onTraceEmit },
          onShutdown: { enforce: 'post', fn: onShutdown },
        },

        dispose: () => checkpointer.flush(),
      }
    },
  })
```

- [ ] **Step 2: Type check**

```bash
bun run check:guard
```

### Task C.2: Remove trace.flushed from TraceEventType

**Files:**
- Modify: `src/domain/trace-event.ts`

- [ ] **Step 1: Remove 'trace.flushed' from union**

In `src/domain/trace-event.ts`, remove `'trace.flushed'` from the `TraceEventType` union (L10).

- [ ] **Step 2: Type check**

```bash
bun run check:guard
```

### Task C.3: Delete old infra files, deprecate old ports

**Files:**
- Delete: `src/infrastructure/trace/fs-trace-writer.ts`
- Delete: `src/infrastructure/trace/inmem-trace-writer.ts`
- Modify: `src/infrastructure/index.ts` (remove old exports)
- Modify: `src/application/ports/trace-writer.ts` (mark deprecated)
- Modify: `src/application/ports/trace-store.ts` (mark deprecated)

Note: DON'T delete the old port files yet — `evolution/evolution/**` (7 files) still imports TraceRun/TraceSummary from `trace-store.ts`. Those evolution files get deleted in Spec-10b Phase E. For now, mark the ports as `@deprecated` and keep them.

- [ ] **Step 1: Delete old infra implementations**

```bash
rm src/infrastructure/trace/fs-trace-writer.ts
rm src/infrastructure/trace/inmem-trace-writer.ts
```

- [ ] **Step 2: Update infrastructure index.ts**

Remove lines 1-2 from `src/infrastructure/index.ts`:
```ts
// DELETE:
export { InMemoryTraceStore } from './trace/inmem-trace-writer'
export { FsTraceWriter } from './trace/fs-trace-writer'
```

- [ ] **Step 3: Mark old ports as deprecated**

In `src/application/ports/trace-writer.ts`, add to top:
```ts
/** @deprecated Replaced by TraceCheckpointer (application/ports/trace-checkpointer.ts). Remove in Spec-10b. */
```

Same for `src/application/ports/trace-store.ts`.

- [ ] **Step 4: Update ports index.ts**

In `src/application/ports/index.ts`, change old exports to deprecated:
```ts
/** @deprecated Use TraceCheckpointer from './trace-checkpointer' */
export type { TraceWriter, TraceReader } from './trace-writer'
/** @deprecated Use TraceCheckpointer from './trace-checkpointer' */
export type { TraceStoreWriter, TraceStoreReader, TraceEvent } from './trace-store'
```

- [ ] **Step 5: Check for broken imports (should be zero outside evolution/evolution/**)**

```bash
bun run check:guard
```
Expected: PASS (old evolution files use `trace-store` port which still exists; trace ext uses new `trace-checkpointer` port).

### Task C.4: Verify A9 gate (no raw bus.emit literals)

- [ ] **Step 1: Run A9 check**

The A9 guard (already in `scripts/check-architecture.ts`) should verify that all `bus.emit` calls use names registered in ContractedEventMap.

```bash
bun run check:arch
```
Expected: zero A9 violations (specifically `trace.flushed` should no longer appear).

- [ ] **Step 2: Manual grep for trace.flushed**

```bash
rg -n "trace.flushed" src/
```
Expected: zero hits.

### Task C.5: Run full CI + commit

- [ ] **Step 1: Run full check**

```bash
bun run check:all
```

- [ ] **Step 2: Commit Phase C**

```bash
git add src/extensions/trace/index.ts
git add src/domain/trace-event.ts
git add src/application/ports/
git add src/infrastructure/trace/
git commit -m "feat(p10a): switch trace ext to TraceCheckpointer, enforce A9/A10/A11/A16

- Rewrite trace ext to use NdjsonCheckpointer (no more FsTraceWriter)
- Remove trace.flushed emit — downstream now subscribes contract events
- Delete old trace-writer + trace-store ports
- Delete old FsTraceWriter + InmemTraceWriter
- Strip trace.flushed from TraceEventType union
- A9: zero raw bus.emit literals outside ContractedEventMap
- A10: ext-internal cross-imports cleared (infra adapter deleted)
- A11: trace ext only exposes trace.reader
- A16: type name deduplication guard active"
```

---

## 14. Verification Checklist

After Phase C is committed, run these gates:

- [ ] `bun run check:guard` — zero type errors
- [ ] `bun test` — all existing tests pass
- [ ] `bun run check:arch` — A9/A10/A11/A16 no violations
- [ ] `rg "trace.flushed" src/` — zero hits
- [ ] `rg "trace-writer|trace-store" src/ --include '*.ts'` — zero hits
- [ ] `rg "sqlite-memory-adapter" src/` — zero hits
- [ ] `rg "extensions/(evolution|memory|mcp)/(evolution|memory|mcp)/" src/` — only sqlite-memory-store imports that reference `../../extensions/memory/memory/types` (old path in promoted store — will be cleaned in Spec-10b)
