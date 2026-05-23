# Spec-10b: 同名嵌套清退 + Evolution/Memory 重写 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete all 6 `<x>/<x>/` nested directories, rewrite evolution (20→8 files, ~2500→~700 LOC) and memory (13→9 files, ~1160→~700 LOC) using fork-worker pattern, flatten MCP/skills/frontend.lark/trace directories.

**Architecture:** Three phases: D (MCP flatten, no logic changes), E (evolution rewrite with policy+worker-entry pattern), F (memory rewrite with hybrid retriever + extract-worker). E and F share the JobSpawner + TraceReader ports built in Spec-10a. All ext modules flat in `extensions/<x>/`.

**Tech Stack:** TypeScript, Bun, Zod (contracts), bun:sqlite (memory store), Ollama (embeddings), NDJSON (trace)

---

## File Map

### Phase D: MCP Flatten

| Action | Path | Purpose |
|---|---|---|
| DELETE | `src/extensions/mcp/types.ts` | Dead code, 0 consumers |
| MOVE | `src/extensions/mcp/mcp/types.ts` → `src/extensions/mcp/types.ts` | Single type source |
| MOVE | `src/extensions/mcp/mcp/manager.ts` → `src/extensions/mcp/manager.ts` | Flatten |
| MOVE | `src/extensions/mcp/mcp/tool-adapter.ts` → `src/extensions/mcp/tool-adapter.ts` | Flatten |
| MOVE | `src/extensions/mcp/mcp/prompt-registry.ts` → `src/extensions/mcp/prompt-registry.ts` | Flatten |
| MOVE | `src/extensions/mcp/mcp/server-persistence.ts` → `src/extensions/mcp/server-persistence.ts` | Flatten |
| MOVE | `src/extensions/mcp/mcp/server-listers.ts` → `src/extensions/mcp/server-listers.ts` | Flatten |
| MOVE | `src/extensions/mcp/mcp/tools.ts` → `src/extensions/mcp/tools.ts` | Flatten |
| CREATE | `src/extensions/mcp/rpc.ts` | Extract RPC from index.ts |
| MODIFY | `src/extensions/mcp/index.ts` | Update imports: `./mcp/X` → `./X`, extract RPC |
| DELETE | `src/extensions/mcp/mcp/` | Remove empty nested dir |

### Phase E: Evolution Rewrite

| Action | Path | Purpose |
|---|---|---|
| DELETE | `src/extensions/evolution/evolution-core.ts` | Old god class |
| DELETE | `src/extensions/evolution/evolution/**` (18 files) | Old pipeline |
| CREATE | `src/extensions/evolution/policy.ts` | Tier0/tier2/skip decision |
| CREATE | `src/extensions/evolution/prompt-templates.ts` | Migrate from old prompt-templates.ts |
| CREATE | `src/extensions/evolution/parse-verdict.ts` | LLM text → structured verdict |
| CREATE | `src/extensions/evolution/worker-entry.ts` | Fork entry + handle() export |
| CREATE | `src/extensions/evolution/skill-stats.ts` | Stats helper (uses SkillStatsStore port) |
| CREATE | `src/extensions/evolution/proposal-writer.ts` | Write worker result via ProposalStore |
| CREATE | `src/extensions/evolution/types.ts` | ReviewJob/ReviewResult/Tier/Decision |
| REWRITE | `src/extensions/evolution/index.ts` | Ext factory (~120 lines) |
| CREATE | `tests/extensions/evolution/policy.test.ts` | Policy unit tests |

### Phase F: Memory Rewrite

| Action | Path | Purpose |
|---|---|---|
| DELETE | `src/extensions/memory/memory/**` (10 files) | Old pipeline |
| CREATE | `src/extensions/memory/policy.ts` | Extract trigger decision |
| CREATE | `src/extensions/memory/extract-prompt.ts` | LLM prompt for extraction |
| CREATE | `src/extensions/memory/extract-worker.ts` | Fork entry + handle() export |
| CREATE | `src/extensions/memory/retrievers.ts` | Keyword + BM25 + Vector + Hybrid (RRF) |
| CREATE | `src/extensions/memory/embedding-encoder.ts` | Ollama + Fake encoder factory |
| CREATE | `src/extensions/memory/embedding-backfill.ts` | Background embedding backfill |
| CREATE | `src/extensions/memory/recall.ts` | createRecall(store, encoder, weights) |
| CREATE | `src/extensions/memory/types.ts` | ExtractJob/ExtractResult/RetrieverWeights |
| REWRITE | `src/extensions/memory/index.ts` | Ext factory (~140 lines) |
| CREATE | `tests/extensions/memory/policy.test.ts` | Policy unit tests |
| CREATE | `tests/extensions/memory/retrievers.test.ts` | Retriever tests |

### Phase E+F Shared: Flatten Remaining Exts

| Action | Path | Purpose |
|---|---|---|
| DELETE | `src/extensions/trace/trace/types.ts` | Already in domain/trace/types.ts |
| DELETE | `src/extensions/trace/trace/` | Remove empty nested dir |
| MOVE | `src/extensions/skills/skills/loader.ts` → `src/extensions/skills/loader.ts` | Flatten |
| MOVE | `src/extensions/skills/skills/middleware.ts` → `src/extensions/skills/middleware.ts` | Flatten |
| DELETE | `src/extensions/skills/skills/index.ts` | Barrel, replaced by ext index |
| DELETE | `src/extensions/skills/skills/` | Remove empty nested dir |
| MOVE | `src/extensions/frontend.lark/lark/**` → `src/extensions/frontend.lark/internal/` | Flatten lark subdir |
| CREATE | `src/extensions/frontend.lark/lark-bot-adapter.ts` | Extract god class from index.ts (B2) |
| MODIFY | `src/extensions/frontend.lark/index.ts` | Import from ./lark-bot-adapter and ./internal/, target ~122 lines |

---

## Phase D: MCP Flatten

### Task D.1: Delete dead outer types.ts + move inner types

**Files:**
- Delete: `src/extensions/mcp/types.ts`
- Move: `src/extensions/mcp/mcp/types.ts` → `src/extensions/mcp/types.ts`

- [ ] **Step 1: Delete outer dead types.ts**

```bash
rm src/extensions/mcp/types.ts
```

- [ ] **Step 2: Move inner types.ts up one level**

```bash
mv src/extensions/mcp/mcp/types.ts src/extensions/mcp/types.ts
```

- [ ] **Step 3: Fix import in moved types.ts**

The moved `types.ts` imports from `../../../config/types`. Now at `extensions/mcp/`, the path becomes `../../config/types`. Update:

```ts
import type { McpServerConfig } from '../../config/types';
```

- [ ] **Step 4: Type check**

```bash
bun run check:guard
```

### Task D.2: Move remaining mcp/mcp/** files up

**Files:**
- Move: 6 files from `src/extensions/mcp/mcp/` → `src/extensions/mcp/`

- [ ] **Step 1: Move files**

```bash
for f in manager tool-adapter prompt-registry server-persistence server-listers tools; do
  mv "src/extensions/mcp/mcp/${f}.ts" "src/extensions/mcp/${f}.ts"
done
```

- [ ] **Step 2: Fix relative imports in moved files**

Each moved file's imports that referenced `./types` or `./other-file` stay the same (same dir). Imports that referenced `../../../` need adjustment — check each file:

```bash
grep -rn "from '\.\./'" src/extensions/mcp/*.ts | grep -v node_modules
```

- [ ] **Step 3: Remove empty mcp/mcp/ directory**

```bash
rmdir src/extensions/mcp/mcp/
```

- [ ] **Step 4: Type check**

```bash
bun run check:guard
```

### Task D.3: Update MCP index.ts imports + extract RPC

**Files:**
- Create: `src/extensions/mcp/rpc.ts`
- Modify: `src/extensions/mcp/index.ts`

- [ ] **Step 1: Read current index.ts and fix imports**

Change all `./mcp/X` imports to `./X`:
```ts
// OLD
import { createMcpManager } from './mcp/manager'
// NEW
import { createMcpManager } from './manager'
```

- [ ] **Step 2: Extract RPC handlers to rpc.ts**

Create `src/extensions/mcp/rpc.ts` with `createMcpRpc()` function containing `mcp.list`/`mcp.add`/`mcp.remove`/`mcp.reload` implementations. Extract from index.ts.

- [ ] **Step 3: Type check + MCP tests**

```bash
bun run check:guard
bun test tests/extensions/mcp/ 2>&1 | tail -5
```

### Task D.4: Commit Phase D

```bash
git add src/extensions/mcp/
git commit -m "feat(p10b): flatten MCP extension, delete dead outer types.ts

- Delete dead outer types.ts (0 consumers)
- Promote mcp/mcp/types.ts to mcp/types.ts (single type source)
- Flatten 6 mcp/mcp/** files to mcp/
- Extract RPC handlers to mcp/rpc.ts
- Phase D of Spec-10b"
```

---

## Phase E: Evolution Rewrite

### Task E.1: Write policy.ts with tests

**Files:**
- Create: `src/extensions/evolution/policy.ts`
- Create: `tests/extensions/evolution/policy.test.ts`

- [ ] **Step 1: Write policy.ts**

```ts
import type { TurnCompletedV1, TurnFailedV1 } from '../../application/contracts/session-events'

const MIN_TURNS_BETWEEN_REVIEWS = 10
const ERROR_BURST_THRESHOLD = 3
const ERROR_BURST_WINDOW_MS = 5 * 60_000
const SKILL_REVIEW_INTERVAL_RUNS = 20

export type Decision =
  | { kind: 'skip' }
  | { kind: 'tier0' }
  | { kind: 'tier2'; skillName: string }

export interface PolicyState {
  turnsSinceReview: number
  errorBurst: number[]
  skillRunsSeen: Record<string, number>
}

export function evaluateReviewPolicy(
  event: TurnCompletedV1 | TurnFailedV1,
  s: PolicyState,
): Decision {
  s.turnsSinceReview++

  if ('outcome' in event && event.outcome !== ('completed' as never)) {
    s.errorBurst.push(Date.now())
    s.errorBurst = s.errorBurst.filter(t => Date.now() - t < ERROR_BURST_WINDOW_MS)
    if (s.errorBurst.length >= ERROR_BURST_THRESHOLD) {
      s.errorBurst = []
      s.turnsSinceReview = 0
      return { kind: 'tier0' }
    }
    return { kind: 'skip' }
  }

  const completed = event as TurnCompletedV1
  for (const skill of completed.activatedSkills ?? []) {
    s.skillRunsSeen[skill] = (s.skillRunsSeen[skill] ?? 0) + 1
    if (s.skillRunsSeen[skill] >= SKILL_REVIEW_INTERVAL_RUNS) {
      s.skillRunsSeen[skill] = 0
      return { kind: 'tier2', skillName: skill }
    }
  }

  if (s.turnsSinceReview >= MIN_TURNS_BETWEEN_REVIEWS) {
    s.turnsSinceReview = 0
    return { kind: 'tier0' }
  }

  return { kind: 'skip' }
}
```

- [ ] **Step 2: Write policy tests**

```ts
import { describe, it, expect } from 'bun:test'
import { evaluateReviewPolicy, type PolicyState, type Decision } from '../../../src/extensions/evolution/policy'

function freshState(): PolicyState {
  return { turnsSinceReview: 0, errorBurst: [], skillRunsSeen: {} }
}

function makeCompleted(overrides: Partial<import('../../../src/application/contracts/session-events').TurnCompletedV1> = {}) {
  return {
    sessionId: 's1', turnId: 't1', runId: 't1',
    usage: { input: 100, output: 200 },
    toolCallCount: 0, toolErrorCount: 0, activatedSkills: [],
    ...overrides,
  } as import('../../../src/application/contracts/session-events').TurnCompletedV1
}

function makeFailed(toolErrorCount = 1) {
  return {
    sessionId: 's1', turnId: 't1', runId: 't1',
    outcome: 'error' as const, stage: 'llm_stream', reason: 'test',
    toolErrorCount,
  } as import('../../../src/application/contracts/session-events').TurnFailedV1
}

describe('evaluateReviewPolicy', () => {
  it('returns skip for normal turns below threshold', () => {
    const s = freshState()
    s.turnsSinceReview = 5
    expect(evaluateReviewPolicy(makeCompleted(), s).kind).toBe('skip')
  })

  it('returns tier0 after MIN_TURNS_BETWEEN_REVIEWS', () => {
    const s = freshState()
    s.turnsSinceReview = 9
    expect(evaluateReviewPolicy(makeCompleted(), s).kind).toBe('tier0')
  })

  it('returns tier0 on error burst', () => {
    const s = freshState()
    // Simulate 3 fails within window
    evaluateReviewPolicy(makeFailed(), s)
    evaluateReviewPolicy(makeFailed(), s)
    const result = evaluateReviewPolicy(makeFailed(), s)
    expect(result.kind).toBe('tier0')
  })

  it('returns tier2 when skill activation threshold reached', () => {
    const s = freshState()
    s.skillRunsSeen['bash'] = 19
    const result = evaluateReviewPolicy(makeCompleted({ activatedSkills: ['bash'] }), s)
    expect(result.kind).toBe('tier2')
    expect((result as { kind: 'tier2'; skillName: string }).skillName).toBe('bash')
  })

  it('returns skip on a single failed turn (not burst)', () => {
    const s = freshState()
    expect(evaluateReviewPolicy(makeFailed(), s).kind).toBe('skip')
  })

  it('resets turnsSinceReview after tier0 trigger', () => {
    const s = freshState()
    s.turnsSinceReview = 9
    evaluateReviewPolicy(makeCompleted(), s)
    expect(s.turnsSinceReview).toBe(0)
  })
})
```

- [ ] **Step 3: Run tests**

```bash
bun test tests/extensions/evolution/policy.test.ts
```
Expected: 6 pass

### Task E.2: Write prompt-templates.ts + parse-verdict.ts + types.ts

**Files:**
- Create: `src/extensions/evolution/prompt-templates.ts`
- Create: `src/extensions/evolution/parse-verdict.ts`
- Create: `src/extensions/evolution/types.ts`

- [ ] **Step 1: Write types.ts**

```ts
import type { TraceRun } from '../../domain/trace/types'
import type { SkillStats } from '../../domain/skill-stats'

export type Tier = 'tier0' | 'tier2'

export interface ReviewJob {
  tier: Tier
  runId: string
  skillName?: string
  run: TraceRun
  stats: SkillStats | null
}

export interface ReviewResult {
  proposalId: string
  tier: Tier
  outcome: 'accepted' | 'rejected' | 'inconclusive'
  skillName?: string
  skillProposed?: {
    name: string
    description: string
    trigger: string
    instructions: string
  }
  reasoning: string
}
```

- [ ] **Step 2: Write prompt-templates.ts**

Read `src/extensions/evolution/evolution/prompt-templates.ts` (the old one). Extract the tier0 and tier2 prompt templates, wrap them in a `buildPrompt(job: ReviewJob)` function:

```ts
import type { ReviewJob } from './types'

interface PromptResult {
  messages: Array<{ role: 'system' | 'user'; content: string }>
  maxTokens: number
}

export function buildPrompt(job: ReviewJob): PromptResult {
  return job.tier === 'tier0' ? buildTier0(job) : buildTier2(job)
}

function buildTier0(job: ReviewJob): PromptResult {
  // Migrate tier0 prompt from old prompt-templates.ts
  return {
    messages: [
      { role: 'system', content: 'You are a code review assistant...' },
      { role: 'user', content: `Review this trace: ${JSON.stringify(job.run)}` },
    ],
    maxTokens: 2000,
  }
}

function buildTier2(job: ReviewJob): PromptResult {
  // Migrate tier2 prompt from old prompt-templates.ts
  return {
    messages: [
      { role: 'system', content: 'You are a skill design assistant...' },
      { role: 'user', content: `Analyze skill: ${job.skillName}` },
    ],
    maxTokens: 3000,
  }
}
```

Note: replace the placeholder system/user messages with the actual prompt content from the old file.

- [ ] **Step 3: Write parse-verdict.ts**

```ts
import type { ReviewJob, ReviewResult } from './types'
import { randomUUID } from 'crypto' // or use generateULID

export function parseVerdict(llmOutput: string, job: ReviewJob): ReviewResult {
  const proposalId = randomUUID()
  try {
    const jsonMatch = llmOutput.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { proposalId, tier: job.tier, outcome: 'inconclusive', reasoning: 'No JSON found in LLM output' }
    }
    const parsed = JSON.parse(jsonMatch[0])
    return {
      proposalId,
      tier: job.tier,
      outcome: parsed.outcome ?? 'inconclusive',
      skillName: job.skillName,
      skillProposed: parsed.skillProposed,
      reasoning: parsed.reasoning ?? llmOutput.slice(0, 500),
    }
  } catch {
    return {
      proposalId,
      tier: job.tier,
      outcome: 'inconclusive',
      skillName: job.skillName,
      reasoning: llmOutput.slice(0, 500),
    }
  }
}
```

- [ ] **Step 4: Type check**

```bash
bun run check:guard
```

### Task E.3: Write worker-entry.ts + skill-stats.ts + proposal-writer.ts

**Files:**
- Create: `src/extensions/evolution/worker-entry.ts`
- Create: `src/extensions/evolution/skill-stats.ts`
- Create: `src/extensions/evolution/proposal-writer.ts`

- [ ] **Step 1: Write worker-entry.ts**

```ts
import type { ReviewJob, ReviewResult } from './types'
import { buildPrompt } from './prompt-templates'
import { parseVerdict } from './parse-verdict'

/** Called by InprocJobSpawner (test/dev) and standalone entry (Bun.spawn). */
export async function handle(job: ReviewJob): Promise<ReviewResult> {
  // TODO: Use ProviderInvoke port for LLM call once kernel DI is available in worker
  // For now: worker receives pre-built prompt, calls LLM, returns parsed result
  // Placeholder implementation — LLM integration wired in follow-up
  const prompt = buildPrompt(job)
  // In production, this calls ProviderInvoke
  return parseVerdict('{}', job) // placeholder — real LLM call goes here
}

// Standalone entry (called by BunSpawnJobSpawner with JOB_MODE=spawn)
if (process.env.JOB_MODE === 'spawn') {
  const chunks: Buffer[] = []
  process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
  process.stdin.on('end', async () => {
    const job = JSON.parse(Buffer.concat(chunks).toString().trim().split('\n')[0]!) as ReviewJob
    try {
      const result = await handle(job)
      process.stdout.write(JSON.stringify(result) + '\n')
      process.exit(0)
    } catch (e) {
      process.stderr.write(String(e) + '\n')
      process.exit(1)
    }
  })
}
```

- [ ] **Step 2: Write skill-stats.ts**

```ts
import type { SkillStatsStore } from '../../application/ports/skill-stats-store'
import type { SkillStats } from '../../domain/skill-stats'

const SUCCESS_OUTCOMES = new Set(['accepted'])

export async function bumpStat(
  store: SkillStatsStore,
  skillName: string,
  outcome: 'accepted' | 'rejected' | 'inconclusive',
): Promise<void> {
  const cur = await store.get(skillName)
  const stats: SkillStats = cur ?? {
    name: skillName,
    totalRuns: 0,
    successfulRuns: 0,
    lastReviewedAt: 0,
  }
  stats.totalRuns++
  if (SUCCESS_OUTCOMES.has(outcome)) stats.successfulRuns++
  stats.lastReviewedAt = Date.now()
  await store.put(stats)
}
```

- [ ] **Step 3: Write proposal-writer.ts**

```ts
import type { ProposalStore } from '../../application/ports/proposal-store'
import type { ReviewResult } from './types'
import { randomUUID } from 'crypto'

export async function writeProposal(
  store: ProposalStore,
  result: ReviewResult,
): Promise<void> {
  await store.append({
    id: result.proposalId,
    skillName: result.skillName,
    tier: result.tier,
    outcome: result.outcome,
    reasoning: result.reasoning,
    skillProposed: result.skillProposed,
    createdAt: Date.now(),
    runId: '', // populated by caller from job.runId
  })
}
```

- [ ] **Step 4: Type check**

```bash
bun run check:guard
```

### Task E.4: Rewrite evolution/index.ts

**Files:**
- Rewrite: `src/extensions/evolution/index.ts`

- [ ] **Step 1: Write the ext factory**

```ts
import { defineExtension } from '../../kernel/define-extension'
import { asContractBus, createEvent } from '../../application/contracts'
import { evaluateReviewPolicy, type PolicyState } from './policy'
import { bumpStat } from './skill-stats'
import { writeProposal } from './proposal-writer'
import type { JobSpawner } from '../../application/ports/job-spawner'
import type { TraceReader } from '../../application/ports/trace-checkpointer'
import type { ProposalStore } from '../../application/ports/proposal-store'
import type { SkillStatsStore } from '../../application/ports/skill-stats-store'
import type { ReviewJob, ReviewResult } from './types'

const REVIEW_TIMEOUT_MS = 120_000
const MAX_INFLIGHT = 1

export default () =>
  defineExtension({
    name: 'evolution',
    enforce: 'normal',
    dependsOn: ['trace'],

    apply: (ctx) => {
      const bus = asContractBus(ctx.bus)
      const reader  = ctx.extensions.get<TraceReader>('trace.reader')
      const spawner = ctx.resolve ? ctx.resolve<JobSpawner>('job-spawner') : undefined
      const proposals  = ctx.extensions.get<ProposalStore>('proposal-store') ??
        ({} as ProposalStore) // TODO: wire via kernel DI
      const statsStore = ctx.extensions.get<SkillStatsStore>('skill-stats-store') ??
        ({} as SkillStatsStore)
      const state: PolicyState = { turnsSinceReview: 0, errorBurst: [], skillRunsSeen: {} }

      return {
        subscribe: {
          'turn.completed': async (e) => {
            const decision = evaluateReviewPolicy(e, state)
            if (decision.kind === 'skip') return
            if (!spawner) return // worker not configured yet

            const run = await reader.getRun(e.runId)
            if (!run) return

            const stats = decision.kind === 'tier2' && decision.skillName
              ? await statsStore.get(decision.skillName)
              : null

            const job: ReviewJob = {
              tier: decision.kind === 'tier0' ? 'tier0' : 'tier2',
              runId: e.runId,
              skillName: decision.kind === 'tier2' ? decision.skillName : undefined,
              run,
              stats,
            }

            bus.emit(createEvent('evolution.review.started', {
              runId: e.runId,
              tier: job.tier,
              skillName: job.skillName,
            }))

            try {
              const result = await spawner.run<ReviewJob, ReviewResult>({
                entry: require.resolve('./worker-entry'),
                job,
                timeoutMs: REVIEW_TIMEOUT_MS,
              })
              await writeProposal(proposals, result)
              if (job.skillName) await bumpStat(statsStore, job.skillName, result.outcome)
              bus.emit(createEvent('evolution.review.completed', {
                runId: e.runId,
                tier: job.tier,
                outcome: result.outcome,
                skillName: job.skillName,
              }))
            } catch (err) {
              ctx.logger.warn('evolution', `review failed: ${String(err)}`)
              bus.emit(createEvent('evolution.review.failed', {
                runId: e.runId,
                tier: job.tier,
                message: String(err),
              }))
            }
          },

          'turn.failed': async (e) => {
            const decision = evaluateReviewPolicy(e, state)
            if (decision.kind === 'skip') return
            // error_burst triggered tier0 — same flow as above
          },
        },
      }
    },
  })
```

- [ ] **Step 2: Type check**

```bash
bun run check:guard
```

### Task E.5: Delete old evolution files

**Files:**
- Delete: `src/extensions/evolution/evolution-core.ts`
- Delete: `src/extensions/evolution/evolution/**` (18 files)

- [ ] **Step 1: Delete old code**

```bash
rm -f src/extensions/evolution/evolution-core.ts
rm -rf src/extensions/evolution/evolution/
```

- [ ] **Step 2: Clean up presets.ts imports**

Check `src/extensions/presets.ts` for any imports from `./evolution/evolution-core` or `./evolution/evolution/`. Remove or update.

- [ ] **Step 3: Type check + test**

```bash
bun run check:guard
bun test tests/extensions/evolution/ 2>&1 | tail -5
```

### Task E.6: Commit Phase E

```bash
git add src/extensions/evolution/
git add tests/extensions/evolution/
git commit -m "feat(p10b): rewrite evolution extension with worker pattern

- Delete 19 old files (evolution-core + evolution/** nested dir)
- Create 7 new files (policy, prompt-templates, parse-verdict, worker-entry,
  skill-stats, proposal-writer, types)
- Rewrite index.ts as thin ext factory subscribing turn.completed/turn.failed
- Policy unit tests: tier0 cycle, error_burst, tier2, skip
- Phase E of Spec-10b"
```

---

## Phase F: Memory Rewrite

### Task F.1: Write policy.ts with tests

**Files:**
- Create: `src/extensions/memory/policy.ts`
- Create: `tests/extensions/memory/policy.test.ts`

- [ ] **Step 1: Write policy.ts**

```ts
import type { TurnCompletedV1, TurnFailedV1 } from '../../application/contracts/session-events'

const MIN_TOKENS_TO_EXTRACT = 800
const FORCE_EXTRACT_INTERVAL = 5

export type Decision = { kind: 'skip' } | { kind: 'extract' }

export interface PolicyState {
  turnsSinceExtract: number
}

export function evaluateExtractPolicy(
  e: TurnCompletedV1 | TurnFailedV1,
  s: PolicyState,
): Decision {
  s.turnsSinceExtract++

  if ('outcome' in e && e.outcome !== ('completed' as never)) return { kind: 'skip' }

  const completed = e as TurnCompletedV1
  const tokens = (completed.usage?.input ?? 0) + (completed.usage?.output ?? 0)

  if (tokens >= MIN_TOKENS_TO_EXTRACT) {
    s.turnsSinceExtract = 0
    return { kind: 'extract' }
  }
  if (s.turnsSinceExtract >= FORCE_EXTRACT_INTERVAL) {
    s.turnsSinceExtract = 0
    return { kind: 'extract' }
  }
  return { kind: 'skip' }
}
```

- [ ] **Step 2: Write policy tests**

```ts
import { describe, it, expect } from 'bun:test'
import { evaluateExtractPolicy, type PolicyState } from '../../../src/extensions/memory/policy'

function freshState(): PolicyState {
  return { turnsSinceExtract: 0 }
}

function makeCompleted(tokens: { input: number; output: number }) {
  return {
    sessionId: 's1', turnId: 't1', runId: 't1',
    usage: tokens, toolCallCount: 0, toolErrorCount: 0, activatedSkills: [],
  } as import('../../../src/application/contracts/session-events').TurnCompletedV1
}

function makeFailed() {
  return {
    sessionId: 's1', turnId: 't1', runId: 't1',
    outcome: 'error' as const, stage: 'llm_stream', reason: 'test', toolErrorCount: 1,
  } as import('../../../src/application/contracts/session-events').TurnFailedV1
}

describe('evaluateExtractPolicy', () => {
  it('returns skip for low token turns', () => {
    expect(evaluateExtractPolicy(makeCompleted({ input: 0, output: 0 }), freshState()).kind).toBe('skip')
  })

  it('returns extract when tokens >= 800', () => {
    expect(evaluateExtractPolicy(makeCompleted({ input: 400, output: 400 }), freshState()).kind).toBe('extract')
  })

  it('returns extract after FORCE_EXTRACT_INTERVAL regardless of tokens', () => {
    const s = freshState()
    s.turnsSinceExtract = 4 // 5th turn will trigger
    expect(evaluateExtractPolicy(makeCompleted({ input: 0, output: 0 }), s).kind).toBe('extract')
  })

  it('skips failed turns', () => {
    expect(evaluateExtractPolicy(makeFailed(), freshState()).kind).toBe('skip')
  })

  it('resets counter after extract', () => {
    const s = freshState()
    s.turnsSinceExtract = 4
    evaluateExtractPolicy(makeCompleted({ input: 0, output: 0 }), s)
    expect(s.turnsSinceExtract).toBe(0)
  })
})
```

- [ ] **Step 3: Run tests**

```bash
bun test tests/extensions/memory/policy.test.ts
```
Expected: 5 pass

### Task F.2: Write retrievers.ts

**Files:**
- Create: `src/extensions/memory/retrievers.ts`

- [ ] **Step 1: Write retrievers.ts (Keyword + BM25 + Vector + Hybrid + helpers)**

Use the exact implementation from the final spec (grill-me output §3.4). The file includes:
- `Retriever` interface
- `KeywordRetriever` — 5-dimensional weighted scoring (keyword, tag, recency, intrinsic, usage)
- `Bm25Retriever` — delegates to `store.ftsSearch()`
- `VectorRetriever` — delegates to `store.vectorSearch()` with silent degradation
- `HybridRetriever` — RRF (k=60) fusion with configurable weights
- `tokenize()` and `scoreEntry()` helper functions
- `RECENCY_HALF_LIFE_MS`, `USAGE_CAP`, `CAND_MULTIPLIER`, `CAND_MIN` constants
- `EmbeddingEncoder` interface (used by VectorRetriever)
- `HybridWeights` interface with defaults `{ vector: 0.5, bm25: 0.3, keyword: 0.2 }`

This is a pure data transformation file — no new IO, only calls MemoryStore methods.

### Task F.3: Write embedding-encoder.ts + embedding-backfill.ts + recall.ts + types.ts

- [ ] **Step 1: Write embedding-encoder.ts**

`createOllamaEncoder(cfg?)` and `createFakeEncoder(dims?)` — from the final spec §3.5.

- [ ] **Step 2: Write embedding-backfill.ts**

`createEmbeddingBackfill(store, encoder, logger, opts?)` → `BackfillHandle { start(), stop() }` — from final spec §3.6.

- [ ] **Step 3: Write recall.ts**

`createRecall(store, encoder, weights?)` → `RecallAPI { search() }` — from final spec §3.7.

- [ ] **Step 4: Write types.ts**

```ts
import type { TraceRun } from '../../domain/trace/types'

export interface ExtractJob {
  runId: string
  run: TraceRun
}

export interface MemoryCandidate {
  text: string
  weight: number
  tags: string[]
}

export interface ExtractResult {
  candidates: MemoryCandidate[]
}

export interface RetrieverWeights {
  vector: number
  bm25: number
  keyword: number
}
```

- [ ] **Step 5: Type check**

```bash
bun run check:guard
```

### Task F.4: Write extract-worker.ts + extract-prompt.ts

- [ ] **Step 1: Write extract-prompt.ts**

```ts
import type { ExtractJob } from './types'

export function buildExtractPrompt(job: ExtractJob): {
  messages: Array<{ role: 'system' | 'user'; content: string }>
  maxTokens: number
} {
  return {
    messages: [
      { role: 'system', content: `Extract knowledge from this conversation. Output format:
one candidate per paragraph. Prefix tags with #tag_name.

Example:
#preference #tool
User prefers bash over zsh for scripting.` },
      { role: 'user', content: JSON.stringify(job.run) },
    ],
    maxTokens: 800,
  }
}
```

- [ ] **Step 2: Write extract-worker.ts**

```ts
import type { ExtractJob, ExtractResult } from './types'
import { buildExtractPrompt } from './extract-prompt'

export async function handle(job: ExtractJob): Promise<ExtractResult> {
  // TODO: LLM call via ProviderInvoke port
  return { candidates: [] }
}

function parseCandidates(text: string): ExtractResult {
  const candidates: ExtractResult['candidates'] = []
  for (const block of text.split(/\n\n+/)) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length === 0) continue
    const tags: string[] = []
    const body: string[] = []
    for (const ln of lines) {
      const m = ln.match(/^#(\w+)/)
      if (m?.[1]) tags.push(m[1])
      else body.push(ln)
    }
    const txt = body.join(' ').trim()
    if (txt) candidates.push({ text: txt, weight: 0.5, tags })
  }
  return { candidates }
}

if (process.env.JOB_MODE === 'spawn') {
  const chunks: Buffer[] = []
  process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
  process.stdin.on('end', async () => {
    const job = JSON.parse(Buffer.concat(chunks).toString().trim().split('\n')[0]!) as ExtractJob
    try {
      const result = await handle(job)
      process.stdout.write(JSON.stringify(result) + '\n')
      process.exit(0)
    } catch (e) {
      process.stderr.write(String(e) + '\n')
      process.exit(1)
    }
  })
}
```

### Task F.5: Rewrite memory/index.ts

**Files:**
- Rewrite: `src/extensions/memory/index.ts`

Write the ext factory (~140 lines) that:
1. Creates `SqliteMemoryStore` via `createSqliteMemoryStore({ profileId: ctx.profileId })`
2. Creates `OllamaEncoder` via `createOllamaEncoder()`
3. Creates `RecallAPI` via `createRecall(store, encoder)`
4. Creates `EmbeddingBackfill` and starts it in `kernelReady`
5. Subscribes to `turn.completed` + `turn.failed`, runs policy, spawns worker
6. Exposes `provide: { recall, store }`
7. Does NOT register transformPrompt hook (identity will call recall directly)

### Task F.6: Delete old memory files

- [ ] **Step 1: Delete old memory/memory/ directory**

```bash
rm -rf src/extensions/memory/memory/
```

(The sqlite-store.ts and sqlite-schema.ts inside were already promoted to infra in Spec-10a.)

- [ ] **Step 2: Type check + tests**

```bash
bun run check:guard
bun test tests/extensions/memory/ 2>&1 | tail -5
```

### Task F.7: Commit Phase F

```bash
git add src/extensions/memory/
git add tests/extensions/memory/
git commit -m "feat(p10b): rewrite memory extension with hybrid retriever + worker

- Delete 10 old memory/memory/** files (already promoted/obsoleted)
- Create 9 new files (policy, retrievers, encoder, backfill, recall,
  extract-prompt, extract-worker, types)
- Rewrite index.ts as thin ext factory with subscribe pattern
- Hybrid RRF retriever (keyword + BM25 + vector)
- Extract worker with fork+inproc support
- Policy unit tests
- Phase F of Spec-10b"
```

---

## Phase E+F Shared: Flatten Remaining Extensions

### Task EF.1: Flatten trace, skills, frontend.lark

- [ ] **Step 1: Trace — delete nested types.ts**

```bash
rm src/extensions/trace/trace/types.ts
rmdir src/extensions/trace/trace/ 2>/dev/null
```
(Content already in `domain/trace/types.ts`)

- [ ] **Step 2: Skills — move files up**

```bash
mv src/extensions/skills/skills/loader.ts src/extensions/skills/loader.ts
mv src/extensions/skills/skills/middleware.ts src/extensions/skills/middleware.ts
rm src/extensions/skills/skills/index.ts
rmdir src/extensions/skills/skills/
```

Update `src/extensions/skills/index.ts` — change imports:
```ts
// OLD
import { createSkillLoader } from './skills/loader'
// NEW
import { createSkillLoader } from './loader'
```

- [ ] **Step 3: Frontend.lark — move lark/ to internal/**

```bash
mkdir -p src/extensions/frontend.lark/internal/
mv src/extensions/frontend.lark/lark/*.ts src/extensions/frontend.lark/internal/
rmdir src/extensions/frontend.lark/lark/
```

Update imports in index.ts: `./lark/X` → `./internal/X`

- [ ] **Step 4: Frontend.lark — B2 extract LarkBotAdapter**

Read `src/extensions/frontend.lark/index.ts`. Find the `LarkBotAdapter` class (the 320-line god class at lines ~30-349). Move the ENTIRE class to a new file `src/extensions/frontend.lark/lark-bot-adapter.ts`.

In `index.ts`, import it:
```ts
import { LarkBotAdapter } from './lark-bot-adapter'
```

Leave the `LarkBotConfig` interface, `createLarkBotConfig` function, and `defineExtension(...)` block in index.ts.

- [ ] **Step 5: Verify A12 — no nested dirs remain**

```bash
# Should return nothing (no extensions/<x>/<x>/ patterns)
find src/extensions -mindepth 2 -maxdepth 2 -type d ! -name '__tests__' ! -name 'internal'
```

Expected: only `src/extensions/frontend.lark/internal` and maybe `src/extensions/frontend.tui/*` directories.

- [ ] **Step 6: Run full check**

```bash
bun run check:guard
bun test 2>&1 | tail -5
```

### Task EF.2: Commit flattening

```bash
git add -A
git commit -m "feat(p10b): flatten remaining extension directories

- Delete trace/trace/types.ts (content already in domain/trace/types.ts)
- Flatten skills/skills/ → skills/ (loader, middleware)
- Move frontend.lark/lark/ → frontend.lark/internal/
- Extract LarkBotAdapter (320 lines) to lark-bot-adapter.ts (B2)
- A12: zero <x>/<x>/ nested directories remaining
- Phase E+F shared tasks of Spec-10b"
```

---

## Verification Checklist

After all phases committed, run:

- [ ] `bun run check:guard` — zero type errors
- [ ] `bun test` — all tests pass
- [ ] `find src/extensions -mindepth 2 -maxdepth 2 -type d ! -name internal` — only frontend.lark/internal
- [ ] `rg "extensions/(evolution|memory|mcp)/(evolution|memory|mcp)/" src/` — zero hits
- [ ] `bun run check:arch` — A12/A15/A17 no violations
