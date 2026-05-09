# Self-Evolution Phase A+B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all correctness and security issues in the self-evolution system (Phase A), then add defense layers to prevent runaway reviews (Phase B).

**Architecture:** Phase A fixes 7 bugs in-place across evolution/ and trace/ modules. Phase B adds 4 new modules (IdleGate, CooldownMap, ReviewSlot, CircuitBreaker) and upgrades the NudgeEngine fingerprint. Each phase develops in a worktree and merges via PR.

**Tech Stack:** TypeScript, Bun test runner, Zod, Node fs/path/crypto

---

## Phase A — P0 Emergency Fixes

**Worktree:** `phase-a-p0-fixes`

### Task 1: Decouple evolution from TUI (B13)

**Files:**
- Modify: `src/evolution/types.ts`
- Modify: `src/evolution/index.ts`
- Modify: `src/trace/agent-middleware.ts`
- Modify: `src/runtime-providers.ts`
- Test: `tests/evolution/evolution-decouple.test.ts`

The evolution module currently imports `useTuiStore` directly from TUI. Replace with a `notify` callback injected through the existing `EvolutionCallback` interface.

- [ ] **Step 1: Add notify to EvolutionCallback type**

In `src/evolution/types.ts`, add the notify callback to `EvolutionCallback`:

```ts
export interface EvolutionCallback {
  review(
    nudgeResult: { signal: string; trigger: string; traceRunId: string; sessionId: string; reason: string },
    trace: TraceRun,
  ): void;
  trackStats(summary: TraceRun['summary'], runId: string): Promise<Array<{ skillName: string; triggerReview: boolean }>>;
  autoAcceptStaleSkills?(): Promise<string[]>;
  runTier2Analysis?(skillName: string, description: string): void;
  notify?(skillName: string, description: string, outputDir: string): void;
}
```

- [ ] **Step 2: Remove useTuiStore import from evolution/index.ts**

In `src/evolution/index.ts`:
- Delete line 8: `import { useTuiStore } from '../cli/tui/state/store';`
- In `initEvolution`, add `notify` parameter to the returned object's methods.
- In `runTier2Analysis` (lines 113-140), replace all `useTuiStore.getState().addReviewNotification(...)` calls with `this.notify?.(...)`. Since `runTier2Analysis` is a method on the returned object, reference it via the closure:

```ts
runTier2Analysis(skillName, description) {
  const stats = { totalRuns: 0, successfulRuns: 0, successRate: 0, lastRunId: '' };
  const prompt = buildAnalysisPrompt(skillName, description, stats, []);
  forkSkillAnalysis(prompt, provider, config.model, (verdict) => { void (async () => {
    if (verdict) {
      const status = await tracker.loadStatus(skillName);
      if (status) {
        status.status = 'reviewed';
        await tracker.saveStatus(status);
      }
      if (verdict.verdict === 'fix') {
        notify?.(skillName, `Analysis: skill needs adjustment — ${verdict.reasoning.slice(0, REASONING_PREVIEW_LENGTH)}... [/review view ${skillName}]`, outputDir);
      } else if (verdict.verdict === 'delete') {
        notify?.(skillName, `Marked as harmful — ${verdict.reasoning.slice(0, REASONING_PREVIEW_LENGTH)}... [/review delete ${skillName}]`, outputDir);
      }
      const evalCase = verdictToEvalCase(skillName, verdict);
      if (evalCase) {
        try {
          await tracker.appendFeedbackEval(skillName, JSON.stringify(verdict));
          feedbackCasesPending++;
          if (feedbackCasesPending >= FEEDBACK_CASES_NOTIFY_THRESHOLD) {
            debugLog(`[evolution] ${feedbackCasesPending} feedback cases pending for prompt optimization`);
            notify?.('prompt-optimization', `${feedbackCasesPending} feedback cases pending — run /review optimize to improve review prompts`, outputDir);
          }
        } catch (err) {
          debugLog(`[evolution] Failed to append feedback: ${err}`);
        }
      }
    }
  })(); });
},
```

- [ ] **Step 3: Remove useTuiStore import from agent-middleware.ts**

In `src/trace/agent-middleware.ts`:
- Delete line 8: `import { useTuiStore } from '../cli/tui/state/store';`
- In `finalizeTrace` (line 98-99), replace `useTuiStore.getState().addReviewNotification(...)` with `this.evolution?.notify?.(...)`:

```ts
for (const { skillName, triggerReview } of results) {
  if (triggerReview) {
    debugLog(`[trace] Low-score warning for ${skillName} — Tier 2 review recommended`);
    this.evolution?.notify?.(skillName, 'Low success rate — Tier 2 analysis triggered', '');
    this.evolution.runTier2Analysis?.(skillName, `Auto skill: ${skillName}`);
  }
}
```

- [ ] **Step 4: Wire notify in runtime-providers.ts**

In `src/runtime-providers.ts`:
- Keep the `import { useTuiStore }` import (runtime layer is the correct place for TUI coupling).
- In `setupEvolution` (line 71-72), change the `onSkillCreated` callback to also wire `notify`:

```ts
return initEvolution({
  enabled: true,
  model,
  maxTurns: review.maxTurns ?? DEFAULT_EVOLUTION_MAX_TURNS,
  tokenLimit: review.tokenLimit ?? DEFAULT_EVOLUTION_TOKEN_LIMIT,
  timeoutMs: review.timeoutMs ?? DEFAULT_EVOLUTION_TIMEOUT_MS,
  outputDir: review.outputDir ?? '~/.my-agent/skills/auto',
  autoAcceptHours: review.autoAcceptHours ?? DEFAULT_AUTO_ACCEPT_HOURS,
  lowScoreWarningThreshold: review.lowScoreWarningThreshold ?? DEFAULT_LOW_SCORE_THRESHOLD,
}, createEvolutionProvider(model), (skillName, description, outputDir) => {
  useTuiStore.getState().addReviewNotification(skillName, description, outputDir);
});
```

Then update `initEvolution` in `src/evolution/index.ts` to accept and store the `onSkillCreated` callback as the `notify` implementation. Change the signature and wire it:

```ts
export function initEvolution(
  config: ReviewConfig,
  provider: Provider,
  notify?: (skillName: string, description: string, outputDir: string) => void,
): EvolutionModule | null {
```

Use the `notify` parameter throughout the returned object. The `onSkillCreated` callback from `forkReviewAgent` can be removed — the `notify` callback handles both skill creation and review notifications.

Actually, keep `onSkillCreated` in `forkReviewAgent` since it fires on a different event (tool call result). The `notify` callback is for the evolution module's own notifications (Tier 2 verdicts, low-score warnings). Both call `addReviewNotification` on the TUI side but through different paths. The key change is that evolution/index.ts no longer imports TUI — it uses the injected `notify`.

- [ ] **Step 5: Write test for decoupling**

Create `tests/evolution/evolution-decouple.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import { initEvolution } from '../../src/evolution';
import type { ReviewConfig } from '../../src/evolution/types';

describe('Evolution TUI decoupling', () => {
  test('initEvolution does not import TUI module', async () => {
    // If evolution/index.ts still imports useTuiStore, this dynamic import
    // would pull in zustand/immer and fail in a minimal environment.
    // We just verify the module loads and returns null when disabled.
    const result = initEvolution(
      { enabled: false, model: 'test', maxTurns: 1, tokenLimit: 1000, timeoutMs: 5000, outputDir: '/tmp' },
      {} as any,
    );
    expect(result).toBeNull();
  });

  test('initEvolution uses injected notify callback', async () => {
    const notifications: Array<{ skillName: string; description: string; outputDir: string }> = [];
    const notify = (skillName: string, description: string, outputDir: string) => {
      notifications.push({ skillName, description, outputDir });
    };
    const result = initEvolution(
      { enabled: true, model: 'test', maxTurns: 1, tokenLimit: 1000, timeoutMs: 5000, outputDir: '/tmp/evolution-test' },
      {} as any,
      notify,
    );
    expect(result).not.toBeNull();
    // The notify callback is stored for later use by runTier2Analysis
  });
});
```

- [ ] **Step 6: Run tests**

Run: `bun test tests/evolution/`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/evolution/types.ts src/evolution/index.ts src/trace/agent-middleware.ts src/runtime-providers.ts tests/evolution/evolution-decouple.test.ts
git commit -m "fix: decouple evolution module from TUI via notify callback (B13)"
```

---

### Task 2: Fix feedback file path to home dir (B10)

**Files:**
- Modify: `src/evolution/effectiveness-tracker.ts:84-96`
- Test: `tests/evolution/effectiveness-tracker.test.ts`

- [ ] **Step 1: Write failing test**

In `tests/evolution/effectiveness-tracker.test.ts`, add:

```ts
test('appendFeedbackEval writes to home dir, not cwd', async () => {
  const tracker = new EffectivenessTracker(TEST_DIR);
  // This test verifies the feedback path is under ~/.my-agent, not process.cwd()
  // We patch os.homedir to a temp dir to avoid polluting real home
  const origHomedir = os.homedir;
  const fakeHome = path.join(os.tmpdir(), `feedback-home-${Date.now()}`);
  os.homedir = () => fakeHome;

  try {
    await tracker.appendFeedbackEval('test-skill', JSON.stringify({ verdict: 'fix', reasoning: 'test', suggestion: 'fix it' }));
    const feedbackPath = path.join(fakeHome, '.my-agent', 'feedback', 'feedback-evals.json');
    const exists = await fs.access(feedbackPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);

    // Verify cwd is not polluted
    const cwdPath = path.join(process.cwd(), 'tests', 'evolution', 'review-prompt-evals-feedback.json');
    const cwdExists = await fs.access(cwdPath).then(() => true).catch(() => false);
    expect(cwdExists).toBe(false);
  } finally {
    os.homedir = origHomedir;
    await fs.rm(fakeHome, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/evolution/effectiveness-tracker.test.ts`
Expected: FAIL — feedback writes to cwd, not home dir

- [ ] **Step 3: Fix the feedback path**

In `src/evolution/effectiveness-tracker.ts`, replace the `appendFeedbackEval` method (lines 74-96):

```ts
private static readonly FEEDBACK_DIR = path.join(os.homedir(), '.my-agent', 'feedback');
private static readonly FEEDBACK_PATH = path.join(EffectivenessTracker.FEEDBACK_DIR, 'feedback-evals.json');

async appendFeedbackEval(
  skillName: string,
  verdictRaw: string,
): Promise<void> {
  const { parseVerdict, verdictToEvalCase } = await import('./skill-analyzer');
  const verdict = parseVerdict(verdictRaw);
  if (!verdict || verdict.verdict !== 'fix') return;
  const evalCase = verdictToEvalCase(skillName, verdict);
  if (!evalCase) return;

  await fs.mkdir(EffectivenessTracker.FEEDBACK_DIR, { recursive: true });

  let existing: unknown[] = [];
  try {
    existing = JSON.parse(await fs.readFile(EffectivenessTracker.FEEDBACK_PATH, 'utf-8'));
  } catch { /* file doesn't exist yet */ }

  existing.push(evalCase);
  await fs.writeFile(EffectivenessTracker.FEEDBACK_PATH, JSON.stringify(existing, null, 2), 'utf-8');
  debugLog(`[evolution] Appended feedback eval case for ${skillName}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/evolution/effectiveness-tracker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/evolution/effectiveness-tracker.ts tests/evolution/effectiveness-tracker.test.ts
git commit -m "fix: write feedback evals to ~/.my-agent/feedback instead of cwd (B10)"
```

---

### Task 3: Validate skill_name against path traversal (B7)

**Files:**
- Modify: `src/evolution/review-tools.ts`
- Test: `tests/evolution/review-tools.test.ts`

- [ ] **Step 1: Write failing test**

In `tests/evolution/review-tools.test.ts`, add:

```ts
test('rejects path traversal in skill_name', async () => {
  const tool = new CreateReviewSkillTool(TEST_DIR);
  const ctx = createTestCtx();

  const result = await tool.execute({
    skill_name: '../etc/passwd',
    description: 'Evil skill',
    body: 'Malicious',
  }, ctx);
  expect(result).toHaveProperty('created', false);
  expect(result).toHaveProperty('reason');
  expect((result as any).reason).toContain('Invalid skill_name');
});

test('rejects absolute path in skill_name', async () => {
  const tool = new CreateReviewSkillTool(TEST_DIR);
  const ctx = createTestCtx();

  const result = await tool.execute({
    skill_name: '/etc/passwd',
    description: 'Evil skill',
    body: 'Malicious',
  }, ctx);
  expect(result).toHaveProperty('created', false);
});

test('rejects unicode and overlong skill_name', async () => {
  const tool = new CreateReviewSkillTool(TEST_DIR);
  const ctx = createTestCtx();

  const result1 = await tool.execute({
    skill_name: '技能名',
    description: 'Unicode name',
    body: 'Content',
  }, ctx);
  expect(result1).toHaveProperty('created', false);

  const result2 = await tool.execute({
    skill_name: 'a'.repeat(50),
    description: 'Too long',
    body: 'Content',
  }, ctx);
  expect(result2).toHaveProperty('created', false);
});

test('accepts valid kebab-case skill_name', async () => {
  const tool = new CreateReviewSkillTool(TEST_DIR);
  const ctx = createTestCtx();

  const result = await tool.execute({
    skill_name: 'my-valid-skill-123',
    description: 'Valid skill',
    body: 'Content',
  }, ctx);
  expect(result).toHaveProperty('created', true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/evolution/review-tools.test.ts`
Expected: FAIL — no validation exists yet

- [ ] **Step 3: Add validation to review-tools.ts**

In `src/evolution/review-tools.ts`, add at the top of the file after imports:

```ts
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;
```

In the `handle` method of `CreateReviewSkillTool`, add validation as the first thing (after the class method declaration, before the `expandTilde` call):

```ts
protected async handle(params: CreateReviewSkillParams, _ctx: ToolContext): Promise<unknown> {
  if (!SKILL_NAME_RE.test(params.skill_name) || params.skill_name.includes('..')) {
    return { created: false, reason: 'Invalid skill_name: must be 2-49 chars, lowercase alphanumeric and hyphens only, no ".."', skill_name: params.skill_name };
  }

  const dir = expandTilde(this.outputDir);
  // ... rest of method unchanged
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/evolution/review-tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/evolution/review-tools.ts tests/evolution/review-tools.test.ts
git commit -m "fix: validate skill_name against path traversal and invalid chars (B7)"
```

---

### Task 4: Don't count aborted as failure (B11)

**Files:**
- Modify: `src/evolution/effectiveness-tracker.ts:51-52`
- Test: `tests/evolution/effectiveness-tracker.test.ts`

- [ ] **Step 1: Write failing test**

In `tests/evolution/effectiveness-tracker.test.ts`, add:

```ts
test('aborted outcome does not lower success rate', async () => {
  const tracker = new EffectivenessTracker(TEST_DIR);

  // 2 completions = 100% success rate
  await tracker.updateStats('abort-test', 'completed', 'r1');
  await tracker.updateStats('abort-test', 'completed', 'r2');
  let status = await tracker.loadStatus('abort-test');
  expect(status!.stats!.successRate).toBe(1.0);

  // 5 aborted runs should not change success rate
  for (let i = 0; i < 5; i++) {
    await tracker.updateStats('abort-test', 'aborted', `a${i}`);
  }
  status = await tracker.loadStatus('abort-test');
  // totalRuns includes aborted, but successfulRuns stays at 2
  expect(status!.stats!.totalRuns).toBe(7);
  expect(status!.stats!.successfulRuns).toBe(2);
  expect(status!.stats!.successRate).toBeCloseTo(2 / 7);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/evolution/effectiveness-tracker.test.ts`
Expected: FAIL — aborted is counted as not-completed, lowering success rate

- [ ] **Step 3: Fix updateStats to treat aborted/cleared as neutral**

In `src/evolution/effectiveness-tracker.ts`, replace the `updateStats` method's success logic (around lines 51-52):

```ts
async updateStats(
  skillName: string,
  traceOutcome: TraceSummary['outcome'],
  runId: string,
): Promise<SkillStats> {
  const status = await this.loadStatus(skillName);
  const prevStats = status?.stats ?? { totalRuns: 0, successfulRuns: 0, successRate: 1, lastRunId: '' };

  const isNeutral = traceOutcome === 'aborted';
  const isSuccess = traceOutcome === 'completed';

  const newStats: SkillStats = {
    totalRuns: prevStats.totalRuns + (isNeutral ? 0 : 1),
    successfulRuns: prevStats.successfulRuns + (isSuccess ? 1 : 0),
    successRate: 0,
    lastRunId: runId,
  };
  newStats.successRate = newStats.totalRuns > 0
    ? newStats.successfulRuns / newStats.totalRuns
    : 1;

  await this.saveStatus({
    skillName,
    status: status?.status ?? 'pending',
    createdAt: status?.createdAt ?? Date.now(),
    sourceRunId: status?.sourceRunId ?? '',
    stats: newStats,
  });

  debugLog(`[evolution] Updated stats for ${skillName}: ${newStats.successRate.toFixed(2)} (${newStats.successfulRuns}/${newStats.totalRuns})`);
  return newStats;
}
```

Key change: `aborted` increments neither totalRuns nor successfulRuns — it's as if the run didn't happen for scoring purposes.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/evolution/effectiveness-tracker.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/evolution/effectiveness-tracker.ts tests/evolution/effectiveness-tracker.test.ts
git commit -m "fix: treat aborted outcome as neutral, not failure (B11)"
```

---

### Task 5: Fix dedup regex mismatch (C1)

**Files:**
- Modify: `src/evolution/review-tools.ts:71,95`
- Test: `tests/evolution/review-tools.test.ts`

The regex `/description:\s*"([^"]+)"/` only matches quoted descriptions, but line 95 writes `description: ${params.description}` without quotes. When descriptions contain spaces or colons, the regex fails to match.

- [ ] **Step 1: Write failing test**

In `tests/evolution/review-tools.test.ts`, add:

```ts
test('dedup matches unquoted description in frontmatter', async () => {
  const tool = new CreateReviewSkillTool(TEST_DIR);
  const ctx = createTestCtx();

  // Create first skill with a description
  await tool.execute({
    skill_name: 'first-skill',
    description: 'Fix permission errors on Linux',
    body: 'Content',
  }, ctx);

  // Try creating a second skill with a very similar description (>80% overlap)
  const result = await tool.execute({
    skill_name: 'second-skill',
    description: 'Fix permission errors on Linux systems',
    body: 'Content',
  }, ctx);

  // Should be deduplicated (overlap > 80%)
  expect(result).toHaveProperty('created', false);
  expect((result as any).reason).toContain('similar');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/evolution/review-tools.test.ts`
Expected: FAIL — dedup regex doesn't match unquoted description

- [ ] **Step 3: Fix regex and frontmatter format**

In `src/evolution/review-tools.ts`, change line 71 regex:

```ts
const descMatch = /^description:\s*"?([^"\n]+?)"?\s*$/m.exec(md);
```

And change line 95 to always quote the description:

```ts
`description: "${params.description.replace(/"/g, '\\"')}"`,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/evolution/review-tools.test.ts`
Expected: PASS

- [ ] **Step 5: Run all existing review-tools tests to check no regression**

Run: `bun test tests/evolution/review-tools.test.ts`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/evolution/review-tools.ts tests/evolution/review-tools.test.ts
git commit -m "fix: dedup regex matches unquoted descriptions, always write quoted frontmatter (C1)"
```

---

### Task 6: Inject store + reviewInterval into review prompt (B1/B2)

**Files:**
- Modify: `src/evolution/types.ts`
- Modify: `src/evolution/index.ts`
- Modify: `src/evolution/review-agent.ts`
- Modify: `src/trace/agent-middleware.ts`
- Modify: `src/trace/index.ts`
- Test: `tests/evolution/review-prompt-data.test.ts`

The review prompt currently has `{recentTraceSummaries}` and `{reviewInterval}` placeholders that resolve to `(none)` and `''` because the TraceStore and reviewInterval are never passed through.

- [ ] **Step 1: Add store + reviewInterval to EvolutionCallback**

In `src/evolution/types.ts`, add optional fields:

```ts
export interface EvolutionCallback {
  review(
    nudgeResult: { signal: string; trigger: string; traceRunId: string; sessionId: string; reason: string },
    trace: TraceRun,
  ): void;
  trackStats(summary: TraceRun['summary'], runId: string): Promise<Array<{ skillName: string; triggerReview: boolean }>>;
  autoAcceptStaleSkills?(): Promise<string[]>;
  runTier2Analysis?(skillName: string, description: string): void;
  notify?(skillName: string, description: string, outputDir: string): void;
  store?: import('../trace/types').TraceStore;
  reviewInterval?: number;
}
```

- [ ] **Step 2: Pass store + reviewInterval through initEvolution**

In `src/evolution/index.ts`, update `initEvolution` to accept and store these:

```ts
export function initEvolution(
  config: ReviewConfig,
  provider: Provider,
  notify?: (skillName: string, description: string, outputDir: string) => void,
  store?: import('../trace/types').TraceStore,
  reviewInterval?: number,
): EvolutionModule | null {
  if (!config.enabled) return null;
  // ... existing code ...
  return {
    outputDir,
    review(nudgeResult, trace) {
      // ... existing code, but pass store + reviewInterval to forkReviewAgent ...
      isReviewRunning = true;
      forkReviewAgent(signal, trace, {
        outputDir,
        provider,
        model: config.model,
        maxTurns: config.maxTurns,
        tokenLimit: config.tokenLimit,
        timeoutMs: config.timeoutMs,
        onSkillCreated: notify,
        onComplete: () => { isReviewRunning = false; },
        store,
        reviewInterval: reviewInterval ?? config.maxTurns,
      });
    },
    // ... rest unchanged, plus add store and reviewInterval to returned object ...
    store,
    reviewInterval: reviewInterval ?? config.maxTurns,
  };
}
```

- [ ] **Step 3: Update forkReviewAgent to use store for recent traces**

In `src/evolution/review-agent.ts`, update `forkReviewAgent` config type to accept `store` and `reviewInterval`:

```ts
config: {
  outputDir: string;
  provider: Provider;
  model: string;
  maxTurns: number;
  tokenLimit: number;
  timeoutMs: number;
  onSkillCreated?: ((skillName: string, description: string, outputDir: string) => void) | undefined;
  onComplete?: (() => void) | undefined;
  store?: import('../trace/types').TraceStore;
  reviewInterval?: number;
};
```

Then in the async body, after `listExistingSkills`, load recent traces:

```ts
let recentTraceSummaries: string[] = [];
if (config.store) {
  try {
    const recentRuns = await config.store.listRecent(10, 3);
    recentTraceSummaries = recentRuns.map(r =>
      `Run ${r.id}: ${r.summary.totalTurns} turns, ${r.summary.totalErrors} errors, outcome: ${r.summary.outcome}`,
    );
  } catch {
    // Best effort
  }
}
```

Then pass these to `buildReviewPrompt`:

```ts
const reviewPrompt = buildReviewPrompt(trigger, trace, existingSkills, config.reviewInterval, recentTraceSummaries);
```

- [ ] **Step 4: Wire store + reviewInterval from trace middleware**

In `src/trace/agent-middleware.ts`, no change needed — `store` and `reviewInterval` are already available on the `EvolutionCallback` interface. They get set when `initEvolution` returns them.

In `src/trace/index.ts`, the `createTraceMiddleware` function already has access to `reviewInterval`. We need to pass `store` to the evolution module. Update `createTraceMiddleware` to set `evolution.store` and `evolution.reviewInterval` after creation:

```ts
export function createTraceMiddleware(options: {
  // ... existing options ...
} = {}): TraceMiddlewareSet {
  const baseDir = options.baseDir ?? DEFAULT_TRACE_DIR;
  const store = options.store ?? new TraceStore(baseDir, options.maxRunsPerSession);
  const redactor = options.redactor ?? new DefaultRedactor(options.redactionMode ?? 'default');
  const statePath = options.baseDir
    ? path.join(options.baseDir, '..', 'trace-state.json')
    : DEFAULT_STATE_PATH;
  const nudgeEngine = new NudgeEngine(statePath, options.reviewInterval);

  // Wire store and reviewInterval into evolution callback
  if (options.evolution) {
    options.evolution.store = store;
    options.evolution.reviewInterval = options.reviewInterval;
  }

  const agentMiddleware = new TraceAgentMiddleware(
    store,
    nudgeEngine,
    redactor,
    options.nudgeEnabled ?? true,
    options.evolution,
    options.skillLoader,
  );
  // ... rest unchanged ...
```

- [ ] **Step 5: Write test for prompt data injection**

Create `tests/evolution/review-prompt-data.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import { buildReviewPrompt } from '../../src/evolution/prompt-templates';
import type { TraceRun } from '../../src/trace/types';

function makeTrace(overrides: Partial<TraceRun> = {}): TraceRun {
  return {
    id: 'test-run',
    sessionId: 'test-session',
    startTime: Date.now(),
    endTime: Date.now(),
    model: 'test',
    turns: [],
    summary: { totalTurns: 5, totalToolCalls: 3, totalErrors: 2, totalTokens: {}, outcome: 'error' },
    ...overrides,
  };
}

describe('Review prompt data injection', () => {
  test('periodic prompt includes reviewInterval when provided', () => {
    const trace = makeTrace();
    const prompt = buildReviewPrompt('periodic', trace, [], 10);
    expect(prompt).toContain('Review interval: every 10 turns');
  });

  test('periodic prompt includes recentTraceSummaries when provided', () => {
    const trace = makeTrace();
    const prompt = buildReviewPrompt('periodic', trace, [], 10, [
      'Run abc: 5 turns, 0 errors, outcome: completed',
      'Run def: 3 turns, 1 errors, outcome: error',
    ]);
    expect(prompt).toContain('Run abc: 5 turns');
    expect(prompt).toContain('Run def: 3 turns');
  });

  test('periodic prompt shows (none) when no summaries provided', () => {
    const trace = makeTrace();
    const prompt = buildReviewPrompt('periodic', trace, [], 10);
    expect(prompt).toContain('(none)');
  });
});
```

- [ ] **Step 6: Run tests**

Run: `bun test tests/evolution/`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/evolution/types.ts src/evolution/index.ts src/evolution/review-agent.ts src/trace/agent-middleware.ts src/trace/index.ts tests/evolution/review-prompt-data.test.ts
git commit -m "feat: inject TraceStore + reviewInterval into review prompt (B1/B2)"
```

---

### Task 7: Tier 2 analysis with real data (B4)

**Files:**
- Modify: `src/evolution/index.ts` (runTier2Analysis method)
- Test: `tests/evolution/tier2-real-data.test.ts`

`runTier2Analysis` currently passes empty stats and empty traces to `buildAnalysisPrompt`. Fix it to load real stats from tracker and real traces from store.

- [ ] **Step 1: Write failing test**

Create `tests/evolution/tier2-real-data.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import { buildAnalysisPrompt } from '../../src/evolution/skill-analyzer';
import type { SkillStats } from '../../src/evolution/types';

describe('Tier 2 analysis with real data', () => {
  test('buildAnalysisPrompt includes real stats', () => {
    const stats: SkillStats = { totalRuns: 10, successfulRuns: 3, successRate: 0.3, lastRunId: 'r5' };
    const prompt = buildAnalysisPrompt('my-skill', 'A test skill', stats, [
      { outcome: 'error', traces: 'Turn 1: bash failed with permission denied' },
    ]);
    expect(prompt).toContain('0.30');
    expect(prompt).toContain('3/10');
    expect(prompt).toContain('permission denied');
  });

  test('buildAnalysisPrompt with empty traces still works', () => {
    const stats: SkillStats = { totalRuns: 5, successfulRuns: 2, successRate: 0.4, lastRunId: 'r3' };
    const prompt = buildAnalysisPrompt('my-skill', 'A test skill', stats, []);
    expect(prompt).toContain('0.40');
    expect(prompt).toContain('2/5');
  });
});
```

- [ ] **Step 2: Run test to verify it passes (buildAnalysisPrompt already works)**

Run: `bun test tests/evolution/tier2-real-data.test.ts`
Expected: PASS — the prompt builder works, the problem is that it's called with empty data

- [ ] **Step 3: Fix runTier2Analysis to load real data**

In `src/evolution/index.ts`, update `runTier2Analysis`:

```ts
runTier2Analysis(skillName, description) {
  void (async () => {
    const stats = (await tracker.loadStatus(skillName))?.stats
      ?? { totalRuns: 0, successfulRuns: 0, successRate: 0, lastRunId: '' };

    let traces: import('./skill-analyzer').TraceSnippet[] = [];
    if (store) {
      try {
        const recentRuns = await store.listRecent(5, 3);
        traces = recentRuns
          .filter(r => r.summary.activatedSkills?.includes(skillName))
          .map(r => ({
            outcome: r.summary.outcome,
            traces: `Turns: ${r.summary.totalTurns}, Errors: ${r.summary.totalErrors}, ` +
              r.turns.map((t, i) => `Turn ${i}: ${t.toolExecutions.map(e => `${e.toolName}(${e.success ? 'ok' : 'fail'})`).join(', ')}`).join('; '),
          }));
      } catch {
        // Best effort
      }
    }

    const prompt = buildAnalysisPrompt(skillName, description, stats, traces);
    forkSkillAnalysis(prompt, provider, config.model, (verdict) => { void (async () => {
      if (verdict) {
        const status = await tracker.loadStatus(skillName);
        if (status) {
          status.status = 'reviewed';
          await tracker.saveStatus(status);
        }
        if (verdict.verdict === 'fix') {
          notify?.(skillName, `Analysis: skill needs adjustment — ${verdict.reasoning.slice(0, REASONING_PREVIEW_LENGTH)}... [/review view ${skillName}]`, outputDir);
        } else if (verdict.verdict === 'delete') {
          notify?.(skillName, `Marked as harmful — ${verdict.reasoning.slice(0, REASONING_PREVIEW_LENGTH)}... [/review delete ${skillName}]`, outputDir);
        }
        const evalCase = verdictToEvalCase(skillName, verdict);
        if (evalCase) {
          try {
            await tracker.appendFeedbackEval(skillName, JSON.stringify(verdict));
            feedbackCasesPending++;
            if (feedbackCasesPending >= FEEDBACK_CASES_NOTIFY_THRESHOLD) {
              debugLog(`[evolution] ${feedbackCasesPending} feedback cases pending for prompt optimization`);
              notify?.('prompt-optimization', `${feedbackCasesPending} feedback cases pending — run /review optimize to improve review prompts`, outputDir);
            }
          } catch (err) {
            debugLog(`[evolution] Failed to append feedback: ${err}`);
          }
        }
      }
    })(); });
  })();
},
```

Note: This replaces the synchronous `runTier2Analysis` with an async wrapper. The method signature on `EvolutionCallback` is already `void`, so the outer caller doesn't await it.

- [ ] **Step 4: Run all evolution tests**

Run: `bun test tests/evolution/`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/evolution/index.ts tests/evolution/tier2-real-data.test.ts
git commit -m "fix: Tier 2 analysis loads real stats and traces from store (B4)"
```

---

### Phase A Verification

- [ ] **Run full type check**

Run: `bun run tsc`
Expected: No errors

- [ ] **Run all evolution tests**

Run: `bun test tests/evolution/`
Expected: All pass

- [ ] **Run full test suite**

Run: `bun test`
Expected: All pass

- [ ] **Verify no useTuiStore in evolution/**

Run: `grep -r "useTuiStore" src/evolution/`
Expected: No matches

- [ ] **Merge Phase A to master**

Create PR from `phase-a-p0-fixes` worktree branch to master.

---

## Phase B — Defense Layers

**Worktree:** `phase-b-defense`
**Depends on:** Phase A merged to master

### Task 8: Per-signal cooldown (B6)

**Files:**
- Modify: `src/trace/nudge-engine.ts`
- Test: `tests/trace/nudge-engine.test.ts`

Replace the single `lastReviewAt` global throttle with per-signal cooldowns.

- [ ] **Step 1: Write failing test**

Create or extend `tests/trace/nudge-engine.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { NudgeEngine } from '../../src/trace/nudge-engine';
import type { TraceRun } from '../../src/trace/types';

const TEST_STATE_PATH = path.join(os.tmpdir(), `nudge-test-${Date.now()}.json`);

function makeTrace(overrides: Partial<TraceRun['summary']> = {}): TraceRun {
  return {
    id: 'run-1',
    sessionId: 's1',
    startTime: Date.now() - 10000,
    endTime: Date.now(),
    model: 'test',
    turns: [],
    summary: {
      totalTurns: 5,
      totalToolCalls: 3,
      totalErrors: 0,
      totalTokens: {},
      outcome: 'completed',
      ...overrides,
    },
  };
}

describe('NudgeEngine cooldown', () => {
  afterEach(async () => {
    await fs.rm(TEST_STATE_PATH, { force: true }).catch(() => {});
  });

  test('per-signal cooldown prevents same signal firing too soon', () => {
    const engine = new NudgeEngine(TEST_STATE_PATH, 10);

    // Fire error_burst
    const result1 = engine.tick(makeTrace({ totalErrors: 3, totalTurns: 5, outcome: 'error' }));
    expect(result1).not.toBeNull();
    expect(result1!.signal).toBe('error_burst');

    // Same signal should not fire again within cooldown
    const result2 = engine.tick(makeTrace({ totalErrors: 3, totalTurns: 5, outcome: 'error' }));
    expect(result2).toBeNull();
  });

  test('different signals can fire independently', () => {
    const engine = new NudgeEngine(TEST_STATE_PATH, 10);

    // Fire error_burst
    const result1 = engine.tick(makeTrace({ totalErrors: 3, totalTurns: 5, outcome: 'error' }));
    expect(result1).not.toBeNull();

    // complex_task should still be able to fire
    const result2 = engine.tick(makeTrace({ totalTurns: 8, totalErrors: 0, outcome: 'completed' }));
    expect(result2).not.toBeNull();
    expect(result2!.signal).toBe('complex_task');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/trace/nudge-engine.test.ts`
Expected: FAIL — current engine uses global `lastReviewAt`, so error_burst blocks complex_task

- [ ] **Step 3: Implement per-signal cooldown in NudgeEngine**

In `src/trace/nudge-engine.ts`, update `NudgeState` type (in `src/trace/types.ts`) to add per-signal cooldown:

In `src/trace/types.ts`:

```ts
export interface NudgeState {
  turnsSinceReview: number;
  fingerprints: Record<string, string[]>;
  lastReviewAt: number;
  lastSignalAt: Record<string, number>;
}
```

In `src/trace/nudge-engine.ts`, add cooldown constants and update tick:

```ts
const SIGNAL_COOLDOWNS: Record<string, number> = {
  error_burst: 2 * 60 * 1000,    // 2 minutes
  complex_task: 10 * 60 * 1000,  // 10 minutes
  periodic: 30 * 60 * 1000,      // 30 minutes
};
const GLOBAL_MIN_INTERVAL_MS = 30 * 1000; // 30 seconds hard floor
```

Replace the global `lastReviewAt` check with per-signal checks:

```ts
tick(trace: TraceRun): NudgeResult | null {
  const now = Date.now();
  // Global hard floor
  if (now - this.state.lastReviewAt < GLOBAL_MIN_INTERVAL_MS) {
    return null;
  }

  const errorRatio = trace.summary.totalTurns > 0
    ? trace.summary.totalErrors / trace.summary.totalTurns
    : 0;

  // Signal 1: Error burst
  if (trace.summary.totalErrors >= ERROR_BURST_MIN_ERRORS && errorRatio >= ERROR_BURST_MIN_ERROR_RATIO) {
    const fp = this.buildFingerprint(trace);
    if (!this.isDuplicate('error_burst', fp) && !this.isOnCooldown('error_burst', now)) {
      return this.emit('error_burst', trace, fp);
    }
  }

  // Signal 2: Complex task
  if (trace.summary.totalTurns >= COMPLEX_TASK_MIN_TURNS && trace.summary.totalErrors === 0) {
    const fp = 'complex:' + this.buildFingerprint(trace);
    if (!this.isDuplicate('complex_task', fp) && !this.isOnCooldown('complex_task', now)) {
      return this.emit('complex_task', trace, fp);
    }
  }

  // Signal 3: Periodic
  this.state.turnsSinceReview += trace.summary.totalTurns;
  if (this.state.turnsSinceReview >= this.reviewInterval) {
    this.state.turnsSinceReview = 0;
    const fp = this.buildFingerprint(trace);
    if (!this.isDuplicate('periodic', fp) && !this.isOnCooldown('periodic', now)) {
      return this.emit('periodic', trace, fp);
    }
  }

  return null;
}

private isOnCooldown(signal: string, now: number): boolean {
  const lastAt = this.state.lastSignalAt?.[signal] ?? 0;
  const cooldown = SIGNAL_COOLDOWNS[signal] ?? GLOBAL_MIN_INTERVAL_MS;
  return now - lastAt < cooldown;
}
```

Update `emit` to record per-signal timestamps:

```ts
private emit(
  signal: 'error_burst' | 'complex_task' | 'periodic',
  trace: TraceRun,
  fingerprint: string,
): NudgeResult {
  this.state.lastReviewAt = Date.now();
  if (!this.state.lastSignalAt) this.state.lastSignalAt = {};
  this.state.lastSignalAt[signal] = Date.now();
  this.recordFingerprint(signal, fingerprint);
  return { /* ... same as before ... */ };
}
```

Update `defaultState`:

```ts
private defaultState(): NudgeState {
  return {
    turnsSinceReview: 0,
    fingerprints: { error_burst: [], complex_task: [], periodic: [] },
    lastReviewAt: 0,
    lastSignalAt: {},
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/trace/nudge-engine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/trace/nudge-engine.ts src/trace/types.ts tests/trace/nudge-engine.test.ts
git commit -m "feat: per-signal cooldown replaces global throttle (B6)"
```

---

### Task 9: Fingerprint upgrade (D2)

**Files:**
- Modify: `src/trace/nudge-engine.ts`
- Test: `tests/trace/nudge-engine.test.ts`

Current fingerprint is just sorted error tool names — too weak. Upgrade to sha1 of signal + error tools + turn bucket + active skills.

- [ ] **Step 1: Write failing test**

In `tests/trace/nudge-engine.test.ts`, add:

```ts
test('fingerprints differ for different error tool sets', () => {
  const engine = new NudgeEngine(TEST_STATE_PATH, 10);
  // Two traces with different failing tools should have different fingerprints
  // and both should fire (no dedup)
  const trace1: TraceRun = {
    id: 'r1', sessionId: 's1', startTime: 1, endTime: 2, model: 'test',
    turns: [{ turnIndex: 0, toolExecutions: [{ toolName: 'bash', success: false, durationMs: 100 }] }],
    summary: { totalTurns: 5, totalToolCalls: 3, totalErrors: 3, totalTokens: {}, outcome: 'error' },
  };
  const trace2: TraceRun = {
    id: 'r2', sessionId: 's1', startTime: 1, endTime: 2, model: 'test',
    turns: [{ turnIndex: 0, toolExecutions: [{ toolName: 'grep', success: false, durationMs: 100 }] }],
    summary: { totalTurns: 5, totalToolCalls: 3, totalErrors: 3, totalTokens: {}, outcome: 'error' },
  };
  const r1 = engine.tick(trace1);
  expect(r1).not.toBeNull();
  const r2 = engine.tick(trace2);
  // Different error tools = different fingerprint, should not be deduped
  expect(r2).not.toBeNull();
});
```

- [ ] **Step 2: Run test to check current behavior**

Run: `bun test tests/trace/nudge-engine.test.ts`
Expected: This should already pass with the current fingerprint (it includes tool names). The real improvement is adding turn bucket and active skills. Let me adjust the test to verify the fingerprint contains more than just tool names.

Actually, the current fingerprint already includes error tool names sorted, so the test above would pass. The D2 fix adds turn bucket + active skills to reduce false dedup. Let me write a more targeted test:

```ts
test('fingerprints include turn bucket and skills for stronger dedup', () => {
  const engine = new NudgeEngine(TEST_STATE_PATH, 10);
  // Two traces with same error tools but different turn counts should have different fingerprints
  const trace1: TraceRun = {
    id: 'r1', sessionId: 's1', startTime: 1, endTime: 2, model: 'test',
    turns: [{ turnIndex: 0, toolExecutions: [{ toolName: 'bash', success: false, durationMs: 100 }] }],
    summary: { totalTurns: 3, totalToolCalls: 1, totalErrors: 2, totalTokens: {}, outcome: 'error' },
  };
  const trace2: TraceRun = {
    id: 'r2', sessionId: 's1', startTime: 1, endTime: 2, model: 'test',
    turns: [{ turnIndex: 0, toolExecutions: [{ toolName: 'bash', success: false, durationMs: 100 }] }],
    summary: { totalTurns: 12, totalToolCalls: 1, totalErrors: 2, totalTokens: {}, outcome: 'error' },
  };
  const r1 = engine.tick(trace1);
  expect(r1).not.toBeNull();
  const r2 = engine.tick(trace2);
  // Different turn bucket = different fingerprint, should not be deduped
  expect(r2).not.toBeNull();
});
```

- [ ] **Step 3: Implement fingerprint upgrade**

In `src/trace/nudge-engine.ts`, add crypto import and update `buildFingerprint`:

```ts
import { createHash } from 'crypto';

// Add at module level:
const FINGERPRINT_LRU_CAP = 50;
const TURN_BUCKET_SIZE = 5;
```

Replace `buildFingerprint`:

```ts
private buildFingerprint(trace: TraceRun): string {
  const errorTools = new Set<string>();
  for (const turn of trace.turns) {
    for (const exec of turn.toolExecutions) {
      if (!exec.success) errorTools.add(exec.toolName);
    }
  }
  const sortedTools = [...errorTools].sort().join(',') || 'no_errors';
  const turnBucket = Math.floor(trace.summary.totalTurns / TURN_BUCKET_SIZE);
  const sortedSkills = [...(trace.summary.activatedSkills ?? [])].sort().join(',') || 'none';
  const raw = `${sortedTools}:${turnBucket}:${sortedSkills}`;
  return createHash('sha1').update(raw).digest('hex').slice(0, 16);
}
```

Also update `MAX_FINGERPRINTS_PER_SIGNAL` to use `FINGERPRINT_LRU_CAP` (50).

- [ ] **Step 4: Run test**

Run: `bun test tests/trace/nudge-engine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/trace/nudge-engine.ts tests/trace/nudge-engine.test.ts
git commit -m "feat: upgrade nudge fingerprint with turn bucket + skills + sha1 (D2)"
```

---

### Task 10: IdleGate — block review while streaming/compacting

**Files:**
- Create: `src/evolution/idle-gate.ts`
- Modify: `src/evolution/index.ts`
- Modify: `src/evolution/types.ts`
- Test: `tests/evolution/idle-gate.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/evolution/idle-gate.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import { IdleGate } from '../../src/evolution/idle-gate';

describe('IdleGate', () => {
  test('allows execution when idle', () => {
    const gate = new IdleGate();
    expect(gate.canRun()).toBe(true);
  });

  test('blocks execution when streaming', () => {
    const gate = new IdleGate();
    gate.setStreaming(true);
    expect(gate.canRun()).toBe(false);
  });

  test('blocks execution when compacting', () => {
    const gate = new IdleGate();
    gate.setCompacting(true);
    expect(gate.canRun()).toBe(false);
  });

  test('allows execution after streaming stops', () => {
    const gate = new IdleGate();
    gate.setStreaming(true);
    expect(gate.canRun()).toBe(false);
    gate.setStreaming(false);
    expect(gate.canRun()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/evolution/idle-gate.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement IdleGate**

Create `src/evolution/idle-gate.ts`:

```ts
import { debugLog } from '../utils/debug';

export class IdleGate {
  private streaming = false;
  private compacting = false;

  setStreaming(value: boolean): void {
    this.streaming = value;
  }

  setCompacting(value: boolean): void {
    this.compacting = value;
  }

  canRun(): boolean {
    const idle = !this.streaming && !this.compacting;
    if (!idle) {
      debugLog(`[evolution] IdleGate blocked: streaming=${this.streaming}, compacting=${this.compacting}`);
    }
    return idle;
  }
}
```

- [ ] **Step 4: Run test**

Run: `bun test tests/evolution/idle-gate.test.ts`
Expected: PASS

- [ ] **Step 5: Wire IdleGate into evolution module**

In `src/evolution/types.ts`, add `idleGate` to `EvolutionCallback`:

```ts
export interface EvolutionCallback {
  // ... existing fields ...
  idleGate?: import('./idle-gate').IdleGate;
}
```

In `src/evolution/index.ts`, create an IdleGate in `initEvolution` and use it in the `review` method:

```ts
// At the top of initEvolution:
const idleGate = new IdleGate();

// In the returned object's review method:
review(nudgeResult, trace) {
  if (isReviewRunning) {
    debugLog('[evolution] Review skipped — another review is already running');
    return;
  }
  if (!idleGate.canRun()) {
    debugLog('[evolution] Review skipped — system not idle');
    return;
  }
  // ... rest unchanged ...
},

// Add to returned object:
idleGate,
```

- [ ] **Step 6: Wire streaming/compacting state into IdleGate from TUI store**

In `src/runtime-providers.ts`, after creating the evolution module, subscribe to TUI store state changes to update IdleGate:

```ts
// In setupEvolution, after initEvolution:
if (result?.idleGate) {
  useTuiStore.subscribe((state) => {
    result.idleGate!.setStreaming(state.stats.streaming);
    result.idleGate!.setCompacting(state.stats.compacting);
  });
}
```

- [ ] **Step 7: Run all evolution tests**

Run: `bun test tests/evolution/`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add src/evolution/idle-gate.ts src/evolution/types.ts src/evolution/index.ts src/runtime-providers.ts tests/evolution/idle-gate.test.ts
git commit -m "feat: IdleGate blocks review while streaming/compacting (L1)"
```

---

### Task 11: ReviewSlot — single pending slot with priority

**Files:**
- Create: `src/evolution/review-slot.ts`
- Modify: `src/evolution/index.ts`
- Test: `tests/evolution/review-slot.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/evolution/review-slot.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import { ReviewSlot } from '../../src/evolution/review-slot';
import type { PendingReview } from '../../src/evolution/review-slot';

describe('ReviewSlot', () => {
  test('accepts task when empty', () => {
    const slot = new ReviewSlot();
    const task: PendingReview = { signal: 'error_burst', priority: 1, nudgeResult: null as any, trace: null as any };
    expect(slot.tryEnqueue(task)).toBe(true);
  });

  test('rejects task when running and no pending slot', () => {
    const slot = new ReviewSlot();
    const task: PendingReview = { signal: 'error_burst', priority: 1, nudgeResult: null as any, trace: null as any };
    slot.tryEnqueue(task);
    slot.markRunning();
    const task2: PendingReview = { signal: 'periodic', priority: 3, nudgeResult: null as any, trace: null as any };
    expect(slot.tryEnqueue(task2)).toBe(true); // queued as pending
  });

  test('higher priority task replaces lower priority pending', () => {
    const slot = new ReviewSlot();
    const low: PendingReview = { signal: 'periodic', priority: 3, nudgeResult: null as any, trace: null as any };
    const high: PendingReview = { signal: 'error_burst', priority: 1, nudgeResult: null as any, trace: null as any };
    slot.tryEnqueue(low);
    slot.markRunning();
    expect(slot.tryEnqueue(high)).toBe(true); // replaces low
    expect(slot.pending?.signal).toBe('error_burst');
  });

  test('lower priority task does not replace higher pending', () => {
    const slot = new ReviewSlot();
    const high: PendingReview = { signal: 'error_burst', priority: 1, nudgeResult: null as any, trace: null as any };
    const low: PendingReview = { signal: 'periodic', priority: 3, nudgeResult: null as any, trace: null as any };
    slot.tryEnqueue(high);
    slot.markRunning();
    expect(slot.tryEnqueue(low)).toBe(false); // rejected
    expect(slot.pending?.signal).toBe('error_burst');
  });

  test('markDone clears running and returns pending', () => {
    const slot = new ReviewSlot();
    const task: PendingReview = { signal: 'error_burst', priority: 1, nudgeResult: null as any, trace: null as any };
    slot.tryEnqueue(task);
    slot.markRunning();
    const pending: PendingReview = { signal: 'periodic', priority: 3, nudgeResult: null as any, trace: null as any };
    slot.tryEnqueue(pending);

    const next = slot.markDone();
    expect(next).not.toBeNull();
    expect(next!.signal).toBe('periodic');
    expect(slot.running).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/evolution/review-slot.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement ReviewSlot**

Create `src/evolution/review-slot.ts`:

```ts
import type { NudgeResult } from '../trace/types';
import type { TraceRun } from '../trace/types';

const SIGNAL_PRIORITY: Record<string, number> = {
  error_burst: 1,
  complex_task: 2,
  periodic: 3,
};

export interface PendingReview {
  signal: string;
  priority: number;
  nudgeResult: NudgeResult;
  trace: TraceRun;
}

export class ReviewSlot {
  running = false;
  pending: PendingReview | null = null;

  tryEnqueue(task: PendingReview): boolean {
    if (!this.running) {
      this.pending = task;
      return true;
    }
    if (!this.pending) {
      this.pending = task;
      return true;
    }
    if (task.priority < this.pending.priority) {
      this.pending = task;
      return true;
    }
    return false;
  }

  markRunning(): void {
    this.running = true;
  }

  markDone(): PendingReview | null {
    this.running = false;
    const next = this.pending;
    this.pending = null;
    return next;
  }
}

export function signalPriority(signal: string): number {
  return SIGNAL_PRIORITY[signal] ?? 3;
}
```

- [ ] **Step 4: Run test**

Run: `bun test tests/evolution/review-slot.test.ts`
Expected: PASS

- [ ] **Step 5: Wire ReviewSlot into evolution module**

In `src/evolution/index.ts`, replace the boolean `isReviewRunning` guard with a `ReviewSlot`:

```ts
import { ReviewSlot, signalPriority } from './review-slot';
// ...
const slot = new ReviewSlot();

// In review method:
review(nudgeResult, trace) {
  if (!idleGate.canRun()) {
    debugLog('[evolution] Review skipped — system not idle');
    // Try to queue in slot
    const task = { signal, priority: signalPriority(signal), nudgeResult, trace };
    if (slot.tryEnqueue(task)) {
      debugLog('[evolution] Queued review for later execution');
    }
    return;
  }
  if (slot.running) {
    const task = { signal, priority: signalPriority(signal), nudgeResult, trace };
    if (slot.tryEnqueue(task)) {
      debugLog('[evolution] Queued review (higher priority than pending)');
    } else {
      debugLog('[evolution] Review skipped — lower priority than pending');
    }
    return;
  }

  slot.tryEnqueue({ signal, priority: signalPriority(signal), nudgeResult, trace });
  slot.markRunning();

  forkReviewAgent(signal, trace, {
    // ... existing config ...
    onComplete: () => {
      const next = slot.markDone();
      if (next && idleGate.canRun()) {
        // Auto-drain next pending task
        slot.tryEnqueue(next);
        slot.markRunning();
        forkReviewAgent(next.signal as any, next.trace, {
          // ... same config ...
          onComplete: () => { slot.markDone(); },
        });
      }
    },
  });
},
```

- [ ] **Step 6: Run all evolution tests**

Run: `bun test tests/evolution/`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/evolution/review-slot.ts src/evolution/index.ts tests/evolution/review-slot.test.ts
git commit -m "feat: ReviewSlot with priority-based single pending slot (L5)"
```

---

### Task 12: CircuitBreaker — pause after consecutive failures

**Files:**
- Create: `src/evolution/circuit-breaker.ts`
- Modify: `src/evolution/index.ts`
- Test: `tests/evolution/circuit-breaker.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/evolution/circuit-breaker.test.ts`:

```ts
import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { CircuitBreaker } from '../../src/evolution/circuit-breaker';

const TEST_STATE_PATH = path.join(os.tmpdir(), `breaker-test-${Date.now()}.json`);

describe('CircuitBreaker', () => {
  afterEach(async () => {
    await fs.rm(TEST_STATE_PATH, { force: true }).catch(() => {});
  });

  test('starts in closed state (allows execution)', () => {
    const breaker = new CircuitBreaker(TEST_STATE_PATH);
    expect(breaker.canRun()).toBe(true);
  });

  test('opens after consecutive failures', () => {
    const breaker = new CircuitBreaker(TEST_STATE_PATH);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.canRun()).toBe(false);
  });

  test('resets on success', () => {
    const breaker = new CircuitBreaker(TEST_STATE_PATH);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.canRun()).toBe(true);
    expect(breaker.failures).toBe(0);
  });

  test('auto-closes after cooldown period', () => {
    const breaker = new CircuitBreaker(TEST_STATE_PATH, 0); // 0ms cooldown for test
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.canRun()).toBe(false);
    // After cooldown, should allow a half-open attempt
    expect(breaker.canRun()).toBe(true); // half-open
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/evolution/circuit-breaker.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement CircuitBreaker**

Create `src/evolution/circuit-breaker.ts`:

```ts
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { debugLog } from '../utils/debug';

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_STATE_DIR = path.join(os.homedir(), '.my-agent', 'state');

type BreakerState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  failures = 0;
  private state: BreakerState = 'closed';
  private openedAt = 0;
  private readonly cooldownMs: number;
  private readonly statePath: string;

  constructor(
    statePath?: string,
    cooldownMs: number = DEFAULT_COOLDOWN_MS,
    private readonly threshold: number = DEFAULT_FAILURE_THRESHOLD,
  ) {
    this.statePath = statePath ?? path.join(DEFAULT_STATE_DIR, 'breaker.json');
    this.cooldownMs = cooldownMs;
  }

  canRun(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (Date.now() - this.openedAt >= this.cooldownMs) {
        this.state = 'half-open';
        debugLog('[evolution] CircuitBreaker half-open — allowing probe attempt');
        return true;
      }
      return false;
    }
    // half-open: allow one attempt
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
    void this.persist();
  }

  recordFailure(): void {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = Date.now();
      debugLog(`[evolution] CircuitBreaker OPEN after ${this.failures} consecutive failures — pausing for ${this.cooldownMs / 1000}s`);
    }
    void this.persist();
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      await fs.writeFile(this.statePath, JSON.stringify({
        state: this.state,
        failures: this.failures,
        openedAt: this.openedAt,
      }), 'utf-8');
    } catch {
      // Best effort
    }
  }
}
```

- [ ] **Step 4: Run test**

Run: `bun test tests/evolution/circuit-breaker.test.ts`
Expected: PASS

- [ ] **Step 5: Wire CircuitBreaker into evolution module**

In `src/evolution/index.ts`, create a CircuitBreaker and check it in the `review` method:

```ts
const breaker = new CircuitBreaker();

// In review method, before IdleGate check:
if (!breaker.canRun()) {
  debugLog('[evolution] Review skipped — CircuitBreaker is open');
  return;
}
```

In `forkReviewAgent` callbacks:
- On success: `breaker.recordSuccess()`
- On failure (in catch): `breaker.recordFailure()`

- [ ] **Step 6: Run all evolution tests**

Run: `bun test tests/evolution/`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/evolution/circuit-breaker.ts src/evolution/index.ts tests/evolution/circuit-breaker.test.ts
git commit -m "feat: CircuitBreaker pauses reviews after consecutive failures"
```

---

### Task 13: Global exponential backoff for review failures

**Files:**
- Create: `src/evolution/review-backoff.ts`
- Modify: `src/evolution/index.ts`
- Test: `tests/evolution/review-backoff.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/evolution/review-backoff.test.ts`:

```ts
import { describe, test, expect } from 'bun:test';
import { ReviewBackoff } from '../../src/evolution/review-backoff';

describe('ReviewBackoff', () => {
  test('allows execution with no failures', () => {
    const backoff = new ReviewBackoff();
    expect(backoff.canRun()).toBe(true);
  });

  test('delays after failure', () => {
    const backoff = new ReviewBackoff();
    backoff.recordFailure();
    expect(backoff.canRun()).toBe(false);
  });

  test('resets on success', () => {
    const backoff = new ReviewBackoff();
    backoff.recordFailure();
    backoff.recordSuccess();
    expect(backoff.canRun()).toBe(true);
  });

  test('backoff increases exponentially', () => {
    const backoff = new ReviewBackoff();
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      const delay = backoff.nextDelay();
      delays.push(delay);
      backoff.recordFailure();
    }
    // Each delay should be >= 2x the previous (before jitter)
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    }
    // Cap at 15 minutes
    expect(delays[delays.length - 1]).toBeLessThanOrEqual(15 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/evolution/review-backoff.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement ReviewBackoff**

Create `src/evolution/review-backoff.ts`:

```ts
import { debugLog } from '../utils/debug';

const BASE_DELAY_MS = 30_000;    // 30 seconds
const MAX_DELAY_MS = 15 * 60_000; // 15 minutes
const JITTER_FACTOR = 0.2;

export class ReviewBackoff {
  private failureCount = 0;
  private nextRunAt = 0;

  canRun(): boolean {
    return Date.now() >= this.nextRunAt;
  }

  nextDelay(): number {
    const raw = Math.min(BASE_DELAY_MS * Math.pow(2, this.failureCount), MAX_DELAY_MS);
    const jitter = raw * JITTER_FACTOR * (2 * Math.random() - 1);
    return Math.max(BASE_DELAY_MS, raw + jitter);
  }

  recordFailure(): void {
    const delay = this.nextDelay();
    this.nextRunAt = Date.now() + delay;
    this.failureCount++;
    debugLog(`[evolution] Review backoff: attempt ${this.failureCount}, next run in ${Math.round(delay / 1000)}s`);
  }

  recordSuccess(): void {
    this.failureCount = 0;
    this.nextRunAt = 0;
  }
}
```

- [ ] **Step 4: Run test**

Run: `bun test tests/evolution/review-backoff.test.ts`
Expected: PASS

- [ ] **Step 5: Wire backoff into evolution review method**

In `src/evolution/index.ts`:

```ts
const backoff = new ReviewBackoff();

// In review method, add after breaker check:
if (!backoff.canRun()) {
  debugLog('[evolution] Review skipped — backoff delay active');
  return;
}
```

In `forkReviewAgent` callbacks:
- On success: `backoff.recordSuccess()`
- On failure: `backoff.recordFailure()`

- [ ] **Step 6: Run all evolution tests**

Run: `bun test tests/evolution/`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/evolution/review-backoff.ts src/evolution/index.ts tests/evolution/review-backoff.test.ts
git commit -m "feat: exponential backoff for review failures (L2)"
```

---

### Phase B Verification

- [ ] **Run full type check**

Run: `bun run tsc`
Expected: No errors

- [ ] **Run all evolution + trace tests**

Run: `bun test tests/evolution/ tests/trace/`
Expected: All pass

- [ ] **Run full test suite**

Run: `bun test`
Expected: All pass

- [ ] **Merge Phase B to master**

Create PR from `phase-b-defense` worktree branch to master.

---

## Phase B Export Cleanup

After all tasks are done, ensure the new modules are exported properly.

- [ ] **Update `src/evolution/index.ts` re-exports**

Add to the bottom of `src/evolution/index.ts`:

```ts
export { IdleGate } from './idle-gate';
export { ReviewSlot, signalPriority } from './review-slot';
export type { PendingReview } from './review-slot';
export { CircuitBreaker } from './circuit-breaker';
export { ReviewBackoff } from './review-backoff';
```

- [ ] **Commit**

```bash
git add src/evolution/index.ts
git commit -m "chore: export new defense modules from evolution index"
```
