# Self-Learning Go-Live Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire LLM invocation into evolution review and memory extract workers, plus promote→SKILL.md output and minimal memory dedup.

**Architecture:** `JobContext { invoke, log }` is injected into worker `handle(job, ctx)` by the spawner. Inproc spawner passes ctx directly; spawn spawner fail-fast throws. `infra-services` exposes a `JobContextFactory` that wraps `ProviderInvoke.call()` with `parentTurnId: ${purpose}:${runId}`. Evolution promote emits `skills.reload-requested` event (not cross-extension RPC). Memory extract prompt is fixed to render TraceRun data into the user message.

**Tech Stack:** TypeScript, Bun, bun:sqlite, Zod (contracts only)

---

### Task 1: JobContext + Spawner protocol upgrade, default to inproc

**Files:**
- Modify: `src/application/ports/job-spawner.ts`
- Modify: `src/infrastructure/jobs/inproc-job-spawner.ts`
- Modify: `src/infrastructure/jobs/bun-spawn-job-spawner.ts`
- Modify: `src/infrastructure/jobs/index.ts`

- [ ] **Step 1: Add `InvokeFn`, `JobContext` types and update `JobSpawner` port**

```ts
// src/application/ports/job-spawner.ts

export interface InvokeFn {
  (req: {
    purpose: string
    messages: Array<{ role: string; content: string }>
    maxTokens?: number
  }): Promise<{ content: string; usage: { input: number; output: number } }>
}

export interface JobContext {
  invoke: InvokeFn
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void
}

export interface JobSpawner {
  run<TJob, TResult>(opts: {
    entry: string
    job: TJob
    ctx: JobContext
    timeoutMs?: number
  }): Promise<TResult>
}
```

- [ ] **Step 2: Update InprocJobSpawner to pass ctx to handle()**

```ts
// src/infrastructure/jobs/inproc-job-spawner.ts
import type { JobSpawner } from '../../application/ports/job-spawner'

export class InprocJobSpawner implements JobSpawner {
  async run<TJob, TResult>(opts: {
    entry: string
    job: TJob
    ctx: { invoke: (req: unknown) => Promise<unknown>; log?: (level: string, msg: string) => void }
    timeoutMs?: number
  }): Promise<TResult> {
    const mod = await import(opts.entry)
    if (typeof mod.handle !== 'function') {
      throw new Error(`${opts.entry} missing exported handle()`)
    }
    return await mod.handle(opts.job, opts.ctx) as TResult
  }
}
```

- [ ] **Step 3: Update BunSpawnJobSpawner to fail-fast on invoke ctx**

```ts
// src/infrastructure/jobs/bun-spawn-job-spawner.ts
/// <reference types="bun" />

import type { JobSpawner } from '../../application/ports/job-spawner'

export class BunSpawnJobSpawner implements JobSpawner {
  async run<TJob, TResult>(opts: {
    entry: string
    job: TJob
    ctx: { invoke?: unknown; log?: unknown }
    timeoutMs?: number
  }): Promise<TResult> {
    if (opts.ctx?.invoke) {
      throw new Error(
        'BunSpawnJobSpawner does not support JobContext.invoke. ' +
        'Workers that need LLM access must use JOB_SPAWNER=inproc (default). ' +
        'See spec: lobster-spawn-llm-bridge (planned).'
      )
    }
    const proc = Bun.spawn(['bun', 'run', opts.entry], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
      env: { ...process.env, JOB_MODE: 'spawn' },
    })

    const payload = JSON.stringify(opts.job) + '\n'
    const writeResult = proc.stdin.write(payload)
    if (writeResult && typeof (writeResult as Promise<unknown>).then === 'function') {
      await writeResult
    }
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

- [ ] **Step 4: Switch default spawner to inproc**

```ts
// src/infrastructure/jobs/index.ts
import type { JobSpawner } from '../../application/ports/job-spawner'
import { BunSpawnJobSpawner } from './bun-spawn-job-spawner'
import { InprocJobSpawner } from './inproc-job-spawner'

export function createJobSpawner(): JobSpawner {
  const mode = process.env.JOB_SPAWNER ?? 'inproc'
  return mode === 'spawn' ? new BunSpawnJobSpawner() : new InprocJobSpawner()
}
```

- [ ] **Step 5: Verify typecheck**

Run: `bun run check:guard`
Expected: PASS (may fail on callers not yet passing ctx — proceed to fix in next steps)

- [ ] **Step 6: Commit**

```bash
git add src/application/ports/job-spawner.ts src/infrastructure/jobs/inproc-job-spawner.ts src/infrastructure/jobs/bun-spawn-job-spawner.ts src/infrastructure/jobs/index.ts
git commit -m "feat(jobs): JobContext + Spawner protocol upgrade, default to inproc"
```

---

### Task 2: job-context-factory + provider.llm wiring in infra-services

**Files:**
- Create: `src/extensions/infra-services/job-context-factory.ts`
- Modify: `src/extensions/infra-services/index.ts`

- [ ] **Step 1: Create JobContextFactory**

```ts
// src/extensions/infra-services/job-context-factory.ts
import type { JobContext } from '../../application/ports/job-spawner'
import type { ProviderInvoke } from '../../application/ports/provider'

export type JobContextFactory = (opts: {
  purpose: string
  runId: string
}) => JobContext

export function createJobContextFactory(
  invoke: ProviderInvoke,
  logger: { info: (d: string, m: string) => void; warn: (d: string, m: string) => void; error: (d: string, m: string) => void },
): JobContextFactory {
  return ({ purpose, runId }) => ({
    invoke: async (req) => {
      const resp = await invoke.call({
        kind: 'internal',
        purpose,
        parentTurnId: `${purpose}:${runId}`,
        messages: req.messages,
        maxTokens: req.maxTokens,
      })
      return { content: resp.content, usage: resp.usage }
    },
    log: (level, msg) => logger[level]('job', msg),
  })
}
```

- [ ] **Step 2: Register factory in infra-services extension**

Edit `src/extensions/infra-services/index.ts`:
- Add import for `createJobContextFactory` and related types
- Get `provider.llm` from extension registry
- Register factory via `provide`

```ts
// src/extensions/infra-services/index.ts — add imports (after line 8):
import { createJobContextFactory } from './job-context-factory'
import type { ProviderInvoke } from '../../application/ports/provider'
```

```ts
// Inside apply(), after line 29 (stats instantiation), add:
const providerInvoke = ctx.extensions.has('provider.llm')
  ? ctx.extensions.get<ProviderInvoke>('provider.llm')
  : undefined
```

```ts
// Update provide block (lines 33-37) to include factory:
provide: {
  'job-spawner': () => spawner,
  'proposal-store': () => proposals,
  'skill-stats-store': () => stats,
  'job-context-factory': () => providerInvoke
    ? createJobContextFactory(providerInvoke, ctx.logger)
    : undefined,
},
```

> **Note**: `providerInvoke` might be undefined if provider extension hasn't registered yet. The factory returns `undefined` in that case, and callers handle it gracefully.

- [ ] **Step 3: Verify typecheck**

Run: `bun run check:guard`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/extensions/infra-services/job-context-factory.ts src/extensions/infra-services/index.ts
git commit -m "feat(infra-services): job-context-factory + provider.llm wiring"
```

---

### Task 3: Wire LLM invoke in evolution worker-entry

**Files:**
- Modify: `src/extensions/evolution/worker-entry.ts`
- Modify: `src/extensions/evolution/index.ts`

- [ ] **Step 1: Update worker-entry to use ctx.invoke**

```ts
// src/extensions/evolution/worker-entry.ts
import type { ReviewJob, ReviewResult } from './types'
import type { JobContext } from '../../application/ports/job-spawner'
import { buildPrompt } from './prompt-templates'
import { parseVerdict } from './parse-verdict'

export async function handle(job: ReviewJob, ctx: JobContext): Promise<ReviewResult> {
  const prompt = buildPrompt(job)
  const purpose = job.tier === 'tier0' ? 'evolution.review.tier0' : 'evolution.review.tier2'
  try {
    const { content } = await ctx.invoke({
      purpose,
      messages: prompt.messages,
      maxTokens: prompt.maxTokens,
    })
    return parseVerdict(content, job)
  } catch (err) {
    ctx.log?.('warn', `LLM invoke failed: ${String(err)}`)
    return parseVerdict('{}', job)
  }
}

if (process.env.JOB_MODE === 'spawn') {
  const chunks: Buffer[] = []
  process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- worker entry fire-and-forget
  process.stdin.on('end', async () => {
    const job = JSON.parse(Buffer.concat(chunks).toString().trim().split('\n')[0]!) as ReviewJob
    try {
      const result = await handle(job, { invoke: async () => { throw new Error('spawn mode does not support LLM invoke') } })
      process.stdout.write(JSON.stringify(result) + '\n')
      process.exit(0)
    } catch (e) {
      process.stderr.write(String(e) + '\n')
      process.exit(1)
    }
  })
}
```

- [ ] **Step 2: Update evolution/index.ts call site to pass ctx**

In `src/extensions/evolution/index.ts`, add import (near line 9):

```ts
import type { JobContextFactory } from '../infra-services/job-context-factory'
```

After line 103, add factory lookup:

```ts
const ctxFactory = reg.has('infra-services.job-context-factory')
  ? reg.get<JobContextFactory>('infra-services.job-context-factory')
  : undefined
```

Update the `if` guard at line 119 to include factory:

```ts
if (!spawner || !proposals || !statsStore || !ctxFactory) return
```

Update the `spawner.run()` call (lines 134-138):

```ts
const result = await spawner.run<ReviewJob, ReviewResult>({
  entry: require.resolve('./worker-entry'),
  job,
  ctx: ctxFactory({
    purpose: tier === 'tier0' ? 'evolution.review.tier0' : 'evolution.review.tier2',
    runId,
  }),
  timeoutMs: REVIEW_TIMEOUT_MS,
})
```

- [ ] **Step 3: Verify typecheck**

Run: `bun run check:guard`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/extensions/evolution/worker-entry.ts src/extensions/evolution/index.ts
git commit -m "feat(evolution): wire LLM invoke in worker-entry"
```

---

### Task 4a: Fix buildExtractPrompt to render TraceRun

**Files:**
- Modify: `src/extensions/memory/extract-prompt.ts`
- Create: `tests/extensions/memory/extract-prompt.test.ts`

- [ ] **Step 1: Rewrite extract-prompt.ts**

```ts
// src/extensions/memory/extract-prompt.ts
import type { ExtractJob } from './types'
import type { TraceRun } from '../../domain/trace/types'

const TURN_PREVIEW_CHARS = 400
const MAX_TURNS_IN_PROMPT = 20
const EXTRACT_MAX_TOKENS = 800

const SYSTEM_PROMPT = `You extract durable, reusable knowledge from a single agent conversation.

Output rules:
- One candidate per paragraph, separated by a blank line.
- Each paragraph starts with one or more #tags on its first line.
- Allowed tags: #preference #decision #fact #general (use the most specific).
- The body (everything after the tags) is the knowledge sentence — make it self-contained and re-readable months later.
- Drop trivia: greetings, one-off file paths, project-specific minutiae the next session won't reuse.
- If nothing durable, output exactly: NONE

Example:
#preference #tools
User prefers ripgrep over grep for code search and asks for case-insensitive matches by default.

#decision #architecture
Adopt SQLite (bun:sqlite) as the default persistence layer across session/trace/evolution/memory stores; in-memory variants removed.`

function formatRunForExtract(run: TraceRun): string {
  const head = [
    `Run ${run.id}  session=${run.sessionId}  model=${run.model}`,
    `turns=${run.summary.totalTurns}  tools=${run.summary.totalToolCalls}  errors=${run.summary.totalErrors}  outcome=${run.summary.outcome}`,
    '',
  ]
  const turns = run.turns.slice(-MAX_TURNS_IN_PROMPT)
  const body: string[] = []
  for (const t of turns) {
    body.push(`--- Turn ${t.turnIndex} ---`)
    if (t.userMessage) body.push(`User: ${t.userMessage.slice(0, TURN_PREVIEW_CHARS)}`)
    if (t.modelResponse?.text) body.push(`Agent: ${t.modelResponse.text.slice(0, TURN_PREVIEW_CHARS)}`)
    const tools = t.modelResponse?.toolCalls.map(c => c.name).join(', ')
    if (tools) body.push(`Tools: ${tools}`)
  }
  return head.concat(body, '', 'Extract knowledge from the above conversation following the output rules.').join('\n')
}

export function buildExtractPrompt(job: ExtractJob): {
  messages: Array<{ role: 'system' | 'user'; content: string }>
  maxTokens: number
} {
  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: formatRunForExtract(job.run) },
    ],
    maxTokens: EXTRACT_MAX_TOKENS,
  }
}
```

- [ ] **Step 2: Write unit tests**

```ts
// tests/extensions/memory/extract-prompt.test.ts
import { describe, it, expect } from 'bun:test'
import { buildExtractPrompt } from '../../../src/extensions/memory/extract-prompt'
import type { TraceRun } from '../../../src/domain/trace/types'

function mockRun(overrides: Partial<TraceRun> = {}): TraceRun {
  return {
    id: 'run-1',
    sessionId: 'sess-1',
    startTime: 1000,
    endTime: 2000,
    model: 'claude-opus-4-7',
    turns: [
      { turnIndex: 1, userMessage: 'Hello, use ripgrep for searching', modelResponse: { text: 'Sure, I will use rg', toolCalls: [{ name: 'bash', arguments: {} }] }, toolExecutions: [] },
      { turnIndex: 2, userMessage: 'Find the config file', modelResponse: { text: 'Found it at /etc/config.yaml', toolCalls: [] }, toolExecutions: [] },
      { turnIndex: 3, userMessage: 'Thanks!', modelResponse: { text: 'You are welcome', toolCalls: [] }, toolExecutions: [] },
    ],
    summary: {
      totalTurns: 3, totalToolCalls: 1, totalErrors: 0,
      totalTokens: { input: 100, output: 200 },
      outcome: 'completed',
    },
    ...overrides,
  }
}

describe('buildExtractPrompt', () => {
  it('renders user messages and agent responses in user content', () => {
    const result = buildExtractPrompt({ runId: 'r1', run: mockRun() })
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0]!.role).toBe('system')
    expect(result.messages[1]!.role).toBe('user')
    const userContent = result.messages[1]!.content
    expect(userContent).toContain('User: Hello, use ripgrep for searching')
    expect(userContent).toContain('Agent: Sure, I will use rg')
    expect(userContent).toContain('User: Find the config file')
    expect(userContent).toContain('Agent: Found it at /etc/config.yaml')
    expect(userContent).toContain('Tools: bash')
  })

  it('caps turns at MAX_TURNS_IN_PROMPT (20)', () => {
    const manyTurns = Array.from({ length: 30 }, (_, i) => ({
      turnIndex: i + 1,
      userMessage: `msg ${i + 1}`,
      modelResponse: { text: `resp ${i + 1}`, toolCalls: [] },
      toolExecutions: [],
    }))
    const run = mockRun({ turns: manyTurns, summary: { totalTurns: 30, totalToolCalls: 0, totalErrors: 0, totalTokens: {}, outcome: 'completed' } })
    const result = buildExtractPrompt({ runId: 'r1', run })
    const userContent = result.messages[1]!.content
    expect(userContent).toContain('Turn 11')   // first rendered (30 - 20 = 10, turnIndex 11)
    expect(userContent).toContain('Turn 30')   // last rendered
    expect(userContent).not.toContain('Turn 1') // trimmed
  })

  it('outputs maxTokens=800', () => {
    const result = buildExtractPrompt({ runId: 'r1', run: mockRun() })
    expect(result.maxTokens).toBe(800)
  })
})
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/extensions/memory/extract-prompt.test.ts`
Expected: 3 tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/extensions/memory/extract-prompt.ts tests/extensions/memory/extract-prompt.test.ts
git commit -m "fix(memory): buildExtractPrompt actually renders TraceRun"
```

---

### Task 4b: Wire LLM invoke in memory worker + parseCandidates

**Files:**
- Modify: `src/extensions/memory/extract-worker.ts`
- Modify: `src/extensions/memory/index.ts`
- Create: `tests/extensions/memory/extract-worker.test.ts`

- [ ] **Step 1: Rewrite extract-worker with ctx.invoke and parseCandidates**

```ts
// src/extensions/memory/extract-worker.ts
import type { ExtractJob, ExtractResult, MemoryCandidate } from './types'
import type { JobContext } from '../../application/ports/job-spawner'
import { buildExtractPrompt } from './extract-prompt'

const DEFAULT_WEIGHT = 1

export async function handle(job: ExtractJob, ctx: JobContext): Promise<ExtractResult> {
  const prompt = buildExtractPrompt(job)
  try {
    const { content } = await ctx.invoke({
      purpose: 'memory.extract',
      messages: prompt.messages,
      maxTokens: prompt.maxTokens,
    })
    return { candidates: parseCandidates(content) }
  } catch (err) {
    ctx.log?.('warn', `LLM invoke failed: ${String(err)}`)
    return { candidates: [] }
  }
}

/** Parses `#tag1 #tag2\nbody` paragraphs into candidates. */
export function parseCandidates(raw: string): MemoryCandidate[] {
  const out: MemoryCandidate[] = []
  const blocks = raw.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean)
  for (const block of blocks) {
    const lines = block.split('\n')
    const first = lines[0]!
    const tagMatches = [...first.matchAll(/#([a-z][a-z0-9-]*)/gi)].map(m => m[1]!.toLowerCase())
    if (tagMatches.length === 0) continue
    const strippedFirst = first.replace(/#[a-z][a-z0-9-]*/gi, '').trim()
    const bodyLines = strippedFirst
      ? [strippedFirst, ...lines.slice(1)]
      : lines.slice(1)
    const text = bodyLines.join('\n').trim()
    if (!text) continue
    out.push({ text, weight: DEFAULT_WEIGHT, tags: tagMatches })
  }
  return out
}

if (process.env.JOB_MODE === 'spawn') {
  const chunks: Buffer[] = []
  process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk))
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- worker entry fire-and-forget
  process.stdin.on('end', async () => {
    const job = JSON.parse(Buffer.concat(chunks).toString().trim().split('\n')[0]!) as ExtractJob
    try {
      const result = await handle(job, { invoke: async () => { throw new Error('spawn mode does not support LLM invoke') } })
      process.stdout.write(JSON.stringify(result) + '\n')
      process.exit(0)
    } catch (e) {
      process.stderr.write(String(e) + '\n')
      process.exit(1)
    }
  })
}
```

- [ ] **Step 2: Write parseCandidates unit tests**

```ts
// tests/extensions/memory/extract-worker.test.ts
import { describe, it, expect } from 'bun:test'
import { parseCandidates } from '../../../src/extensions/memory/extract-worker'

describe('parseCandidates', () => {
  it('parses single candidate with one tag', () => {
    const result = parseCandidates('#preference\nUser prefers ripgrep over grep.')
    expect(result).toHaveLength(1)
    expect(result[0]!.text).toBe('User prefers ripgrep over grep.')
    expect(result[0]!.tags).toEqual(['preference'])
    expect(result[0]!.weight).toBe(1)
  })

  it('parses multiple tags on first line', () => {
    const result = parseCandidates('#preference #tools\nUser likes bash.')
    expect(result).toHaveLength(1)
    expect(result[0]!.tags).toEqual(['preference', 'tools'])
  })

  it('parses multiple candidates separated by blank line', () => {
    const result = parseCandidates('#fact\nSky is blue.\n\n#preference\nUser likes dark themes.')
    expect(result).toHaveLength(2)
    expect(result[0]!.text).toBe('Sky is blue.')
    expect(result[0]!.tags).toEqual(['fact'])
    expect(result[1]!.text).toBe('User likes dark themes.')
    expect(result[1]!.tags).toEqual(['preference'])
  })

  it('skips block without any #tag', () => {
    const result = parseCandidates('No tags here.\n\n#fact\nHas a fact.')
    expect(result).toHaveLength(1)
    expect(result[0]!.text).toBe('Has a fact.')
  })

  it('skips block with tags but empty body', () => {
    const result = parseCandidates('#preference\n\n#fact\nReal fact here.')
    expect(result).toHaveLength(1)
    expect(result[0]!.text).toBe('Real fact here.')
  })

  it('handles Windows-style line endings (\\r\\n)', () => {
    const result = parseCandidates('#fact\r\nFact body.\r\n\r\n#preference\r\nPref body.')
    expect(result).toHaveLength(2)
    expect(result[0]!.text).toBe('Fact body.')
    expect(result[1]!.text).toBe('Pref body.')
  })

  it('returns empty array for "NONE" sentinel', () => {
    const result = parseCandidates('NONE')
    expect(result).toEqual([])
  })

  it('handles multi-line body text', () => {
    const result = parseCandidates('#decision\nFirst line.\nSecond line.\nThird line.')
    expect(result).toHaveLength(1)
    expect(result[0]!.text).toBe('First line.\nSecond line.\nThird line.')
  })

  it('tags are lowercased', () => {
    const result = parseCandidates('#Preference #TOOLS\nBody.')
    expect(result[0]!.tags).toEqual(['preference', 'tools'])
  })
})
```

- [ ] **Step 3: Run tests**

Run: `bun test tests/extensions/memory/extract-worker.test.ts`
Expected: 9 tests PASS

- [ ] **Step 4: Update memory/index.ts to use factory and pass ctx**

Add import to `src/extensions/memory/index.ts` (near line 13):

```ts
import type { JobContextFactory } from '../infra-services/job-context-factory'
```

After line 120 (spawner lookup), add factory lookup:

```ts
const ctxFactory = ctx.extensions.has('infra-services.job-context-factory')
  ? ctx.extensions.get<JobContextFactory>('infra-services.job-context-factory')
  : undefined
```

Update the guard at the start of the turn.completed handler (line 180) to include factory:

```ts
if (!spawner || !ctxFactory) return
```

Update the spawner.run call (lines 188-192):

```ts
const result = await spawner.run<ExtractJob, ExtractResult>({
  entry: require.resolve('./extract-worker'),
  job: { runId: e.runId, run },
  ctx: ctxFactory({ purpose: 'memory.extract', runId: e.runId }),
  timeoutMs: EXTRACT_TIMEOUT_MS,
})
```

- [ ] **Step 5: Verify typecheck**

Run: `bun run check:guard`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/extensions/memory/extract-worker.ts src/extensions/memory/index.ts tests/extensions/memory/extract-worker.test.ts
git commit -m "feat(memory): wire LLM invoke + parseCandidates"
```

---

### Task 5: hasExactDuplicate on MemoryStore port + inferType in memory/index.ts

**Files:**
- Modify: `src/application/ports/memory-store.ts`
- Modify: `src/infrastructure/memory/sqlite-schema.ts`
- Modify: `src/infrastructure/memory/sqlite-memory-store.ts`
- Modify: `src/extensions/memory/index.ts`

- [ ] **Step 1: Add hasExactDuplicate to MemoryStore port**

Insert before `/** Delete all entries` (after line 27 in memory-store.ts):

```ts
  /** Exact-match dedupe check: same text AND same type. NOT semantic similarity. */
  hasExactDuplicate(args: { text: string; type: MemoryEntry['type'] }): Promise<boolean>
```

- [ ] **Step 2: Add index migration to sqlite-schema.ts**

Insert before the closing `}` of `initMemoryTables` (after the last `db.run('CREATE INDEX...')` line):

```ts
  db.run('CREATE INDEX IF NOT EXISTS idx_memory_type_text ON memory(type, text)')
```

- [ ] **Step 3: Add hasExactDuplicate implementation to SqliteMemoryStore**

In `src/infrastructure/memory/sqlite-memory-store.ts`, add a prepared statement field (after line 33 `this.closed = false`):

```ts
  private hasExactDuplicateStmt: ReturnType<Database['prepare']> | null = null

  private getHasExactDuplicateStmt() {
    if (!this.hasExactDuplicateStmt) {
      this.hasExactDuplicateStmt = this.db.prepare(
        'SELECT 1 FROM memory WHERE type = ? AND text = ? LIMIT 1'
      )
    }
    return this.hasExactDuplicateStmt
  }
```

Add the method (before `async close()`):

```ts
  async hasExactDuplicate({ text, type }: { text: string; type: MemoryEntry['type'] }): Promise<boolean> {
    return !!this.getHasExactDuplicateStmt().get(type, text)
  }
```

- [ ] **Step 4: Add inferType and update write loop in memory/index.ts**

Replace the write loop (lines 193-202 in memory/index.ts):

```ts
for (const c of result.candidates) {
  const type = inferType(c.tags)
  if (await store.hasExactDuplicate({ text: c.text, type })) continue
  await store.add({
    type,
    text: c.text,
    weight: c.weight,
    source: 'implicit',
    tags: c.tags,
    usageCount: 0,
  })
}
```

Add `inferType` function at module scope (e.g., after the `MEM_SEARCH_TEXT_PREVIEW_CHARS` constant on line 30):

```ts
function inferType(tags: string[]): MemoryType {
  if (tags.includes('preference') || tags.includes('pref')) return 'preference'
  if (tags.includes('decision')) return 'decision'
  if (tags.includes('fact')) return 'fact'
  return 'general'
}
```

- [ ] **Step 5: Verify typecheck**

Run: `bun run check:guard`
Expected: PASS

- [ ] **Step 6: Run existing memory tests**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/application/ports/memory-store.ts src/infrastructure/memory/sqlite-schema.ts src/infrastructure/memory/sqlite-memory-store.ts src/extensions/memory/index.ts
git commit -m "feat(memory): hasExactDuplicate + inferType"
```

---

### Task 6: Evolution promote → SKILL.md + skills.reload-requested event

**Files:**
- Create: `src/application/contracts/skills-events.ts`
- Modify: `src/application/contracts/evolution-events.ts` — add `SkillsReloadRequestedV1` import+export convenience; actually just add to `contracted-event-map.ts`
- Modify: `src/application/contracts/events/contracted-event-map.ts`
- Create: `src/extensions/evolution/promote-writer.ts`
- Modify: `src/extensions/evolution/index.ts`
- Modify: `src/extensions/skills/index.ts`
- Modify: `src/application/ports/proposal-store.ts`
- Modify: `src/infrastructure/evolution/sqlite-proposal-store.ts`

- [ ] **Step 1: Add SkillsReloadRequestedV1 contract**

```ts
// src/application/contracts/skills-events.ts (new file)
export interface SkillsReloadRequestedV1 {
  reason: 'evolution.promote' | 'manual' | 'config-change'
  source?: string
}
```

- [ ] **Step 2: Register in contracted-event-map**

In `src/application/contracts/events/contracted-event-map.ts`, add import:

```ts
import type { SkillsReloadRequestedV1 } from '../skills-events'
```

Add to ContractedEventMap interface (alphabetically after `'skills.reloaded'`):

```ts
  'skills.reload-requested': SkillsReloadRequestedV1
```

- [ ] **Step 3: Extend ProposalStore.markAccepted with optional filePath**

```ts
// src/application/ports/proposal-store.ts — update markAccepted signature:
  markAccepted(id: string, meta?: { filePath?: string }): Promise<void>
```

```ts
// src/infrastructure/evolution/sqlite-proposal-store.ts — update implementation:
  async markAccepted(id: string, meta?: { filePath?: string }): Promise<void> {
    const filePath = meta?.filePath ?? null
    this.db.run(`UPDATE proposals SET status = 'accepted', decided_at = ?, file_path = ? WHERE id = ?`, [Date.now(), filePath, id])
  }
```

> **Note**: If the `proposals` table doesn't have a `file_path` column, add a migration. Check the schema:
> - Read `src/infrastructure/evolution/sqlite-evolution-schema.ts`
> - If `file_path` column is missing, add `ALTER TABLE proposals ADD COLUMN file_path TEXT` migration

- [ ] **Step 3a: Check and update evolution schema if needed**

Check the schema file, add `file_path TEXT` column if missing. Use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` or check in `initEvolutionTables`.

- [ ] **Step 4: Create promote-writer.ts**

```ts
// src/extensions/evolution/promote-writer.ts
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProposalRecord } from '../../domain/evolution-proposal'

function renderSkillMd(p: NonNullable<ProposalRecord['skillProposed']>): string {
  return [
    '---',
    `name: ${p.name}`,
    `description: ${p.description}`,
    `trigger: ${p.trigger}`,
    '---',
    '',
    p.instructions,
    '',
  ].join('\n')
}

export function promoteToSkill(opts: {
  proposal: ProposalRecord
  skillsDir: string
}): { filePath: string } {
  const p = opts.proposal.skillProposed
  if (!p) throw new Error('proposal has no skillProposed payload')
  const safeName = p.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase()
  const dir = join(opts.skillsDir, safeName)
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'SKILL.md')
  const md = renderSkillMd(p)
  writeFileSync(filePath, md, 'utf8')
  return { filePath }
}
```

- [ ] **Step 5: Update evolution promote RPC handler**

In `src/extensions/evolution/index.ts`, add imports:

```ts
import { promoteToSkill } from './promote-writer'
```

Update the `'evolution.promote'` RPC handler (lines 168-174) to:

```ts
'evolution.promote': async (params: unknown) => {
  if (!proposals) throw new Error('proposal-store not available')
  const p = params as { id?: string } | undefined
  if (!p?.id) throw new Error('id is required')

  const list = await proposals.list({ limit: 100 })
  const proposal = list.find(e => e.id === p.id)
  if (!proposal) throw new Error(`proposal ${p.id} not found`)

  let filePath: string | undefined
  if (proposal.skillProposed) {
    const result = promoteToSkill({ proposal, skillsDir: ctx.paths.skills.agent })
    filePath = result.filePath
  }

  await proposals.markAccepted(p.id, filePath ? { filePath } : undefined)

  bus.emit(createEvent('skills.reload-requested', {
    reason: 'evolution.promote',
    source: p.id,
  }))

  return { status: 'promoted', filePath }
},
```

> **Note**: The existing proposal lookup uses `proposals.list({ limit: 100 })` with a `.find()` because the Store interface doesn't have a `get(id)` method. This is the existing pattern already in use.

- [ ] **Step 6: Update skills extension to subscribe to reload-requested**

In `src/extensions/skills/index.ts`, extract the reload logic into a shared function.

After line 83 (inside `apply()`, after `skills` map declaration), add:

```ts
const doReload = async () => {
  try {
    const before = skills.size
    loader.clearCache()
    const loaded = await loader.loadAllSkills()
    for (const info of loaded) {
      skills.set(info.name, fromSkillInfo(info))
    }
    const added = skills.size - before
    contractBus.emit(createEvent('skills.reloaded', { added, removed: 0, updated: 0 }))
    return { added, removed: 0, updated: 0 }
  } catch {
    return { added: 0, removed: 0, updated: 0 }
  }
}
```

Update the `'skills.reload'` RPC handler (replacing lines 156-170) to delegate to doReload:

```ts
'skills.reload': async () => doReload(),
```

Add a `subscribe` block to the return value (alongside the existing hooks/slash/rpc):

```ts
subscribe: {
  'skills.reload-requested': async () => {
    try { await doReload() } catch (e) { ctx.logger.warn('skills', `reload-requested failed: ${String(e)}`) }
  },
},
```

- [ ] **Step 7: Verify typecheck**

Run: `bun run check:guard`
Expected: PASS

- [ ] **Step 8: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 9: Run architecture check**

Run: `bun run check:arch`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/application/contracts/skills-events.ts src/application/contracts/events/contracted-event-map.ts src/application/ports/proposal-store.ts src/infrastructure/evolution/sqlite-proposal-store.ts src/extensions/evolution/promote-writer.ts src/extensions/evolution/index.ts src/extensions/skills/index.ts
git commit -m "feat(evolution): promote → SKILL.md + skills.reload-requested event"
```

---

### Final verification

- [ ] Run full CI check: `bun run check:all`
- [ ] Verify no dead code: `bun run check:deadcode`
- [ ] Verify git log shows 6 commits in order
