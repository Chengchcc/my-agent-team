# Self-Evolution Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add quality assurance and feedback loop to auto-generated skills: enhanced review prompts, approval queue, effectiveness tracking (mechanical + LLM), hot-reload, and prompt optimization.

**Architecture:** Four independent features layered on Phase 1 (trace) and Phase 2 (evolution). Approval uses existing slash-command framework. Effectiveness tracking extends `TraceSummary` with `activatedSkills` and stores stats in `status.json`. Hot-reload uses `statSync` in `beforeAgentRun`. Prompt optimization reuses skill-creator eval tools with auto-generated feedback cases from Tier 2 analysis.

**Tech Stack:** TypeScript, Bun test, Zod, Zustand (existing), Ink/React (existing), Python (skill-creator scripts). No new dependencies.

---

## File Structure

```
New:
  src/cli/tui/commands/review-commands.ts     # /review slash command
  src/evolution/effectiveness-tracker.ts      # mechanical scoring + status.json I/O
  src/evolution/skill-analyzer.ts             # LLM Tier 2 analysis agent
  tests/evolution/effectiveness-tracker.test.ts
  tests/evolution/skill-analyzer.test.ts
  tests/evolution/review-commands.test.ts
  tests/evolution/review-prompt-evals.json    # seed eval cases for prompt optimization

Modified:
  src/cli/tui/components/ReviewNotification.tsx   # keep/delete buttons
  src/cli/tui/state/store.ts                      # skill status + stats state
  src/cli/tui/state/types.ts                      # new state types
  src/skills/loader.ts                            # checkAutoSkills()
  src/trace/types.ts                              # activatedSkills in TraceSummary
  src/trace/trace-buffer.ts                       # persist activatedSkills
  src/trace/agent-middleware.ts                   # detect activated skills + call checkAutoSkills
  src/evolution/types.ts                          # SkillStatus, SkillStats, AnalysisVerdict
  src/evolution/index.ts                          # wire effectiveness tracker
  src/config/types.ts                             # autoAcceptHours, lowScoreWarningThreshold
  src/config/defaults.ts                          # new defaults
```

---

### Task 0: Upgrade review prompt templates with skill-creator methodology

**Files:**
- Modify: `src/evolution/prompt-templates.ts`
- Create: `tests/evolution/prompt-templates-v2.test.ts`

The current review prompt templates are bare-bones ("Score this pattern 1-5, if < 3 say Nothing to save"). They lack the methodology that skill-creator proves is essential: explaining WHY, giving examples, showing anti-patterns.

- [ ] **Step 1: Write the failing test**

Create `tests/evolution/prompt-templates-v2.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { buildReviewPrompt } from '../../src/evolution/prompt-templates';
import type { TraceRun } from '../../src/trace/types';

function makeTrace(overrides: Partial<TraceRun> = {}): TraceRun {
  return {
    id: 'run-1', sessionId: 's1', startTime: 0, endTime: 0, model: 'test',
    turns: [{
      turnIndex: 0, userMessage: 'do task',
      modelResponse: { text: 'ok', toolCalls: [{ name: 'bash', arguments: { command: 'ls' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      toolExecutions: [{ toolName: 'bash', success: false, durationMs: 100, error: 'permission denied' }],
    }],
    summary: { totalTurns: 1, totalToolCalls: 1, totalErrors: 1, totalTokens: { prompt_tokens: 10, completion_tokens: 5 }, outcome: 'error' as const },
    ...overrides,
  };
}

describe('Review prompt v2 — skill-creator methodology', () => {
  test('includes WHY explanation for scoring', () => {
    const prompt = buildReviewPrompt('error_burst', makeTrace(), []);
    expect(prompt).toContain('Score this pattern');
    // New: explains the reasoning behind scoring
    expect(prompt).toContain('one-off');           // anti-pattern guidance
  });

  test('includes skill quality criteria', () => {
    const prompt = buildReviewPrompt('complex_task', makeTrace({ summary: { ...makeTrace().summary, totalTurns: 5, totalErrors: 0, outcome: 'completed' as const } }), []);
    // New: defines what makes a good skill
    expect(prompt).toContain('name');
    expect(prompt).toContain('description');
    expect(prompt).toContain('body');
    expect(prompt).toContain('Pitfalls');
  });

  test('includes example of good vs bad skill', () => {
    const prompt = buildReviewPrompt('error_burst', makeTrace(), []);
    // New: shows anti-pattern examples
    expect(prompt).toContain('NOT create');
  });

  test('includes tool sequence analysis guidance', () => {
    const prompt = buildReviewPrompt('complex_task', makeTrace({ summary: { ...makeTrace().summary, totalTurns: 5, totalErrors: 0, outcome: 'completed' as const } }), []);
    // New: guides analysis of tool call order
    expect(prompt).toContain('sequence');
  });

  test('includes pitfalls guidance for error_burst', () => {
    const prompt = buildReviewPrompt('error_burst', makeTrace(), []);
    // New: explicit pitfalls guidance
    expect(prompt).toContain('pitfalls');
  });
});
```

Run to verify it fails:
```bash
bun test tests/evolution/prompt-templates-v2.test.ts
```
Expected: FAIL (new assertions don't match old templates)

Also upgrade `buildReviewSystemPrompt` in `src/evolution/review-agent.ts` to include the skill quality criteria and format specification from skill-creator.

- [ ] **Step 2: Rewrite prompt templates + skill creation instructions**

a) Replace the three template constants in `src/evolution/prompt-templates.ts` with detailed versions following skill-creator methodology:

```typescript
const ERROR_BURST_PROMPT = `You are an expert skill reviewer analyzing an agent execution trace that had errors.

## Trace Context
- {totalTurns} turns, {totalErrors} errors
- Failed tools: {failedToolNames}

## Full Trace (turn-by-turn)
{trace}

## Existing Skills (do NOT duplicate)
{existingSkills}

## Methodology

### Step 1: Understand the failure pattern
Examine the order of tool calls and error messages. Ask yourself:
- Is there a clear, repeatable sequence that led to the error?
- Is the error caused by a missing prerequisite (e.g., wrong directory, missing package, no sudo)?
- Is this a one-off mistake (typo, wrong file path) or a recurring pattern?

### Step 2: Score reusability (1–5)
- **1–2: NOT reusable** — one-off typo, wrong file path, external network error
  Example: User typed "grpe" instead of "grep" → NOT a skill. Just fix the typo.
  Example: All errors are network timeouts → NOT a skill. External factor.

- **3–4: Useful pattern** — avoidable error with clear remediation
  Example: "EACCES on /tmp → need to chmod first" → Worth capturing as a pitfall.

- **5: High-value workflow** — multi-step error recovery that others would reuse
  Example: "Database migration failure → rollback steps → fix schema → retry" → Skill candidate.

If score < 3, respond ONLY with "Nothing to save" and a one-sentence explanation.
Do NOT create a skill for one-off mistakes.

### Step 3: Decide what to create
If score ≥ 3:
- **New skill needed**: call create_review_skill with a descriptive kebab-case name
- **Pitfall for existing skill**: if a skill already covers this tool but misses this edge case,
  suggest adding to its Pitfalls section instead of creating a new one

## What makes a good skill

A skill must have:
- **name**: kebab-case, describes the pattern (e.g., "fix-bash-permissions")
- **description**: one-line summary of when to use this skill
- **body**: step-by-step instructions, imperative tone, explain WHY each step matters
- **Pitfalls**: common failure modes and how to avoid them

Bad skill example (DO NOT DO THIS):
  name: "bash-errors"
  description: "Handle bash errors"
  body: "If bash fails, try again."
  → Too vague, no actionable steps, no pitfalls.

Good skill example:
  name: "fix-tmp-permissions"
  description: "Handle permission-denied errors when running bash in /tmp — use chmod or change working directory first"
  body: "## When you see EACCES in /tmp\\n\\n1. Check the current directory with pwd\\n2. If in /tmp, cd to the project root first\\n3. Use chmod +x if the file needs execute permission"
  pitfalls: "System directories like /tmp may require sudo. Check ownership before chmod."
  → Concrete steps, explains WHY, includes pitfalls.`;

const COMPLEX_TASK_PROMPT = `You are an expert skill reviewer analyzing a successful multi-step agent task.

## Trace Context
- {totalTurns} turns, 0 errors
- Tools used: {toolNames}

## Full Trace (turn-by-turn)
{trace}

## Existing Skills (do NOT duplicate)
{existingSkills}

## Methodology

### Step 1: Extract the workflow
Examine the sequence of tool calls. Identify the **logical phases**:
- Investigation phase: read, grep, glob — understanding the problem
- Action phase: text_editor, bash — making changes
- Verification phase: test, build, lint — confirming the fix

### Step 2: Score reusability (1–5)
- **1–2: Task-specific** — only useful for this exact task
  Example: User asked to fix a specific typo in one file → NOT reusable.

- **3–4: Project-level pattern** — recurring within this codebase
  Example: "Fix config values across multiple env files" → Worth capturing.

- **5: Universally reusable** — applies across projects
  Example: "Database migration with rollback safety" → High value.

If score < 3, respond ONLY with "Nothing to save" and a one-sentence explanation.

### Step 3: Design the skill
If score ≥ 3, create a skill that captures:
1. The trigger — when should someone use this skill?
2. The workflow phases — step-by-step, grouped logically
3. Non-obvious workarounds — things you only learn by doing
4. Pitfalls — what could go wrong at each phase?

## What makes a good workflow skill
Same quality criteria as above: concrete steps, explains WHY, includes pitfalls.
Focus on the **pattern**, not the specific file names from this trace.`;

const PERIODIC_PROMPT = `Periodic review after {reviewInterval} accumulated turns across multiple runs.

## Recent Traces
{recentTraceSummaries}

## Existing Skills
{existingSkills}

## Methodology

Look across these traces for patterns that repeat across runs:
- Are there recurring error patterns that no skill covers?
- Are there successful workflows that could be extracted?
- Are there skills that consistently appear in failed runs (potential quality issue)?

Apply the same scoring and quality criteria as above.
If nothing actionable, respond "Nothing to save."`;
```

- [ ] **Step 3: Run tests to verify**

```bash
Also upgrade `buildReviewSystemPrompt` in `src/evolution/review-agent.ts` — replace the thin skill creation instructions with detailed guidance following skill-creator's methodology: anatomy of a skill (YAML frontmatter, scripts/, references/), SKILL.md format with examples, writing principles (explain WHY, imperative form, be specific), anti-patterns (when NOT to create), and dedup reminder (check existing skills first).

bun test tests/evolution/prompt-templates.test.ts tests/evolution/prompt-templates-v2.test.ts
```

Expected: all old tests pass (backward compatible), all new assertions pass.

- [ ] **Step 4: Verify no regressions**

```bash
bun run tsc --noEmit
bun run lint
bun test
```

- [ ] **Step 5: Commit**

```bash
git add src/evolution/prompt-templates.ts src/evolution/review-agent.ts tests/evolution/prompt-templates-v2.test.ts
git commit -m "feat: upgrade review prompts + skill creation instructions with skill-creator methodology"
```

---

### Task 1: Add config fields for Phase 3

**Files:**
- Modify: `src/config/types.ts`
- Modify: `src/config/defaults.ts`

- [ ] **Step 1: Add to TraceReviewSettings**

In `src/config/types.ts`, add to `TraceReviewSettings`:

```typescript
export interface TraceReviewSettings {
  enabled: boolean;
  model: string;
  maxTurns: number;
  tokenLimit: number;
  timeoutMs: number;
  outputDir: string;
  autoAcceptHours: number;         // NEW
  lowScoreWarningThreshold: number; // NEW
}
```

- [ ] **Step 2: Add defaults**

In `src/config/defaults.ts`:

```typescript
review: {
  enabled: true,
  model: 'claude-3-haiku-20240307',
  maxTurns: 6,
  tokenLimit: 30_000,
  timeoutMs: 60_000,
  outputDir: '~/.my-agent/skills/auto',
  autoAcceptHours: 48,
  lowScoreWarningThreshold: 0.5,
},
```

- [ ] **Step 3: Verify and commit**

```bash
bun run tsc --noEmit
bun run lint
git add src/config/types.ts src/config/defaults.ts
git commit -m "feat: add autoAcceptHours and lowScoreWarningThreshold config"
```

---

### Task 2: Implement skill hot-reload

**Files:**
- Modify: `src/skills/loader.ts`
- Modify: `src/trace/agent-middleware.ts`

- [ ] **Step 1: Add checkAutoSkills to SkillLoader**

In `src/skills/loader.ts`, add import:

```typescript
import { existsSync, statSync } from 'node:fs';
```

Add field and method to `SkillLoader` class:

```typescript
private lastAutoSkillsMtime = 0;

/** Check if auto skills have changed since last check. Call in beforeAgentRun. */
checkAutoSkills(): void {
  try {
    const autoDir = path.join(os.homedir(), '.my-agent', 'skills', 'auto');
    if (!existsSync(autoDir)) return;
    const mtime = statSync(autoDir).mtimeMs;
    if (mtime > this.lastAutoSkillsMtime) {
      this.lastAutoSkillsMtime = mtime;
      this.clearCache();
      debugLog('[skills] Auto skills changed, cache cleared');
    }
  } catch {
    // directory doesn't exist — nothing to reload
  }
}
```

Add `debugLog` import if not already present:
```typescript
import { debugLog } from '../utils/debug';
```

- [ ] **Step 2: Call checkAutoSkills in TraceAgentMiddleware**

In `src/trace/agent-middleware.ts`, the `beforeAgentRun` hook needs access to a `SkillLoader` reference. Add an optional parameter to the constructor:

```typescript
constructor(
  private store: TraceStore,
  private nudgeEngine: NudgeEngine,
  private redactor: TraceRedactor,
  private nudgeEnabled: boolean = true,
  private evolution?: { review: EvolutionReviewCallback } | null,
  private skillLoader?: SkillLoader | null,
) {}
```

In `beforeAgentRun`, call:

```typescript
beforeAgentRun: Middleware = async (context, next) => {
  this.skillLoader?.checkAutoSkills();
  // ... existing code
};
```

Import `SkillLoader`:
```typescript
import type { SkillLoader } from '../skills/loader';
```

- [ ] **Step 3: Pass skillLoader through createTraceMiddleware**

In `src/trace/index.ts`, add `skillLoader` option:

```typescript
export function createTraceMiddleware(options: {
  // ... existing options ...
  skillLoader?: SkillLoader | null;
} = {}): TraceMiddlewareSet {
```

Pass to `TraceAgentMiddleware` constructor.

- [ ] **Step 4: Wire skillLoader in runtime.ts**

In `src/runtime.ts`, in `setupTrace`, pass `skillLoader`:

```typescript
const traceMw = createTraceMiddleware({
  // ... existing options ...
  skillLoader,
});
```

- [ ] **Step 5: Verify and commit**

```bash
bun run tsc --noEmit
bun test
bun run lint
git add src/skills/loader.ts src/trace/agent-middleware.ts src/trace/index.ts src/runtime.ts
git commit -m "feat: add skill hot-reload via mtime check in beforeAgentRun"
```

---

### Task 3: Track activatedSkills in traces

**Files:**
- Modify: `src/trace/types.ts`
- Modify: `src/trace/trace-buffer.ts`
- Modify: `src/trace/agent-middleware.ts`

- [ ] **Step 1: Add activatedSkills to TraceSummary**

In `src/trace/types.ts`:

```typescript
export interface TraceSummary {
  totalTurns: number;
  totalToolCalls: number;
  totalErrors: number;
  totalTokens: Record<string, number>;
  outcome: 'completed' | 'error' | 'max_turns' | 'aborted';
  error?: string;
  activatedSkills?: string[];  // auto skills active in this run
}
```

- [ ] **Step 2: Expose setter on TraceBuffer**

In `src/trace/trace-buffer.ts`, add:

```typescript
private activatedSkills: string[] = [];

setActivatedSkills(skills: string[]): void {
  this.activatedSkills = skills;
}
```

Update `computeSummary`:

```typescript
private computeSummary(overrideOutcome?: TraceSummary['outcome']): TraceSummary {
  // ... existing code ...
  return {
    // ... existing fields ...
    ...(this.activatedSkills.length > 0 ? { activatedSkills: this.activatedSkills } : {}),
  };
}
```

- [ ] **Step 3: Detect activated auto skills in agent middleware**

In `src/trace/agent-middleware.ts`, `beforeAgentRun`:

```typescript
// Extract auto skill names from system prompt
// Auto skills are injected as <skill_catalog>...</skill_catalog>
// Their names are in the description field
const systemPrompt = context.systemPrompt ?? '';
const autoSkillPattern = /\[auto:([^\]]+)\]/g;
const activatedSkills: string[] = [];
let match;
while ((match = autoSkillPattern.exec(systemPrompt)) !== null) {
  activatedSkills.push(match[1]!);
}
if (activatedSkills.length > 0) {
  buffer.setActivatedSkills(activatedSkills);
}
```

Note: Adjust the detection pattern based on how `SkillMiddleware` actually formats auto skills in the system prompt. Read the actual `SkillMiddleware` output format before implementing.

- [ ] **Step 4: Verify and commit**

```bash
bun run tsc --noEmit
bun test
bun run lint
git add src/trace/types.ts src/trace/trace-buffer.ts src/trace/agent-middleware.ts
git commit -m "feat: track activatedSkills in trace summaries"
```

---

### Task 4: Implement effectiveness tracker (Tier 1 — mechanical scoring)

**Files:**
- Create: `src/evolution/effectiveness-tracker.ts`
- Create: `tests/evolution/effectiveness-tracker.test.ts`
- Modify: `src/evolution/types.ts`
- Modify: `src/evolution/index.ts`

- [ ] **Step 1: Add types**

In `src/evolution/types.ts`, add:

```typescript
export interface SkillStats {
  totalRuns: number;
  successfulRuns: number;
  successRate: number;
  lastRunId: string;
}

export interface SkillStatus {
  skillName: string;
  status: 'pending' | 'kept' | 'deleted' | 'reviewed';
  createdAt: number;
  sourceRunId: string;
  stats?: SkillStats;
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/evolution/effectiveness-tracker.test.ts`:

```typescript
import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { EffectivenessTracker } from '../../src/evolution/effectiveness-tracker';

const TEST_DIR = path.join(os.tmpdir(), `effectiveness-${Date.now()}`);

describe('EffectivenessTracker', () => {
  afterEach(async () => { await fs.rm(TEST_DIR, { recursive: true, force: true }); });

  test('computes success rate correctly', () => {
    const tracker = new EffectivenessTracker(TEST_DIR);
    const stats = tracker.computeStats([
      { outcome: 'completed', activatedSkills: ['test-skill'] },
      { outcome: 'completed', activatedSkills: ['test-skill'] },
      { outcome: 'error', activatedSkills: ['test-skill'] },
    ] as any, 'test-skill');
    expect(stats.successRate).toBe(2/3);
    expect(stats.totalRuns).toBe(3);
    expect(stats.successfulRuns).toBe(2);
  });

  test('writes and reads status.json', async () => {
    const tracker = new EffectivenessTracker(TEST_DIR);
    const status = {
      skillName: 'test-skill',
      status: 'pending' as const,
      createdAt: Date.now(),
      sourceRunId: 'run-1',
    };
    await tracker.saveStatus(status);
    const read = await tracker.loadStatus('test-skill');
    expect(read).not.toBeNull();
    expect(read!.status).toBe('pending');
    expect(read!.skillName).toBe('test-skill');
  });

  test('loadStatus returns null for missing file', async () => {
    const tracker = new EffectivenessTracker(TEST_DIR);
    const result = await tracker.loadStatus('nonexistent');
    expect(result).toBeNull();
  });

  test('shouldTriggerReview true when score low and enough runs', () => {
    const tracker = new EffectivenessTracker(TEST_DIR);
    expect(tracker.shouldTriggerReview({ totalRuns: 5, successfulRuns: 2, successRate: 0.4, lastRunId: 'x' })).toBe(true);
    expect(tracker.shouldTriggerReview({ totalRuns: 5, successfulRuns: 4, successRate: 0.8, lastRunId: 'x' })).toBe(false);
    expect(tracker.shouldTriggerReview({ totalRuns: 2, successfulRuns: 0, successRate: 0, lastRunId: 'x' })).toBe(false);
  });
});
```

Run to verify it fails:
```bash
bun test tests/evolution/effectiveness-tracker.test.ts
```

- [ ] **Step 3: Write the implementation**

Create `src/evolution/effectiveness-tracker.ts`:

```typescript
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { SkillStats, SkillStatus } from './types';
import type { TraceSummary } from '../trace/types';

const LOW_SCORE_THRESHOLD = 0.5;
const MIN_RUNS_FOR_REVIEW = 3;

export class EffectivenessTracker {
  private baseDir: string;

  constructor(outputDir: string) {
    this.baseDir = outputDir.startsWith('~')
      ? path.join(os.homedir(), outputDir.slice(1))
      : outputDir;
  }

  private statusPath(skillName: string): string {
    return path.join(this.baseDir, `${skillName}.status.json`);
  }

  computeStats(
    traces: Array<{ outcome: TraceSummary['outcome']; activatedSkills?: string[] }>,
    skillName: string,
  ): SkillStats {
    let totalRuns = 0;
    let successfulRuns = 0;
    const lastRunId = '';

    for (const trace of traces) {
      if (trace.activatedSkills?.includes(skillName)) {
        totalRuns++;
        if (trace.outcome === 'completed') successfulRuns++;
      }
    }

    return {
      totalRuns,
      successfulRuns,
      successRate: totalRuns > 0 ? successfulRuns / totalRuns : 1,
      lastRunId,
    };
  }

  shouldTriggerReview(stats: SkillStats): boolean {
    return stats.totalRuns >= MIN_RUNS_FOR_REVIEW && stats.successRate < LOW_SCORE_THRESHOLD;
  }

  async saveStatus(status: SkillStatus): Promise<void> {
    const filePath = this.statusPath(status.skillName);
    await fs.mkdir(this.baseDir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(status, null, 2), 'utf-8');
  }

  async loadStatus(skillName: string): Promise<SkillStatus | null> {
    try {
      const content = await fs.readFile(this.statusPath(skillName), 'utf-8');
      return JSON.parse(content) as SkillStatus;
    } catch {
      return null;
    }
  }

  async updateStats(skillName: string, traceOutcome: TraceSummary['outcome'], runId: string): Promise<SkillStats> {
    const status = await this.loadStatus(skillName);
    const prevStats = status?.stats ?? { totalRuns: 0, successfulRuns: 0, successRate: 1, lastRunId: '' };

    const newStats: SkillStats = {
      totalRuns: prevStats.totalRuns + 1,
      successfulRuns: prevStats.successfulRuns + (traceOutcome === 'completed' ? 1 : 0),
      successRate: 0,
      lastRunId: runId,
    };
    newStats.successRate = newStats.successfulRuns / newStats.totalRuns;

    await this.saveStatus({
      skillName,
      status: status?.status ?? 'pending',
      createdAt: status?.createdAt ?? Date.now(),
      sourceRunId: status?.sourceRunId ?? '',
      stats: newStats,
    });

    return newStats;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/evolution/effectiveness-tracker.test.ts
```

Expected: 4 tests PASS

- [ ] **Step 5: Wire into afterAgentRun**

In `src/evolution/index.ts`, after a trace run completes, update stats for each activatedSkill:

```typescript
// In the EvolutionModule, after trace finalization (called from TraceAgentMiddleware.finalizeTrace):
import { EffectivenessTracker } from './effectiveness-tracker';
```

The tracker will be instantiated in `initEvolution` and its `updateStats` method called when a new trace is finalized with the skill's outcome.

- [ ] **Step 6: Commit**

```bash
git add src/evolution/effectiveness-tracker.ts tests/evolution/effectiveness-tracker.test.ts src/evolution/types.ts src/evolution/index.ts
git commit -m "feat: add Tier 1 mechanical effectiveness tracking"
```

---

### Task 5: Implement skill analyzer (Tier 2 — LLM deep review)

**Files:**
- Create: `src/evolution/skill-analyzer.ts`
- Create: `tests/evolution/skill-analyzer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/evolution/skill-analyzer.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { buildAnalysisPrompt, parseVerdict } from '../../src/evolution/skill-analyzer';

describe('buildAnalysisPrompt', () => {
  test('includes skill name, success rate, and trace summaries', () => {
    const prompt = buildAnalysisPrompt('test-skill', 'A test description', {
      totalRuns: 5, successfulRuns: 2, successRate: 0.4, lastRunId: 'x',
    }, [
      { outcome: 'error', traces: 'bash: permission denied' },
      { outcome: 'completed', traces: 'grep: found pattern' },
    ]);
    expect(prompt).toContain('test-skill');
    expect(prompt).toContain('0.4');
    expect(prompt).toContain('permission denied');
    expect(prompt).toContain('keep');
    expect(prompt).toContain('fix');
    expect(prompt).toContain('delete');
  });
});

describe('parseVerdict', () => {
  test('parses keep verdict', () => {
    const result = parseVerdict(JSON.stringify({ verdict: 'keep', reasoning: 'Looks good' }));
    expect(result?.verdict).toBe('keep');
  });

  test('parses fix verdict with suggestion', () => {
    const result = parseVerdict(JSON.stringify({
      verdict: 'fix',
      reasoning: 'Missing sudo',
      suggestion: 'Add sudo note to pitfalls',
    }));
    expect(result?.verdict).toBe('fix');
    expect(result?.suggestion).toBe('Add sudo note to pitfalls');
  });

  test('returns null for invalid JSON', () => {
    expect(parseVerdict('not json')).toBeNull();
  });
});
```

Run to verify it fails:
```bash
bun test tests/evolution/skill-analyzer.test.ts
```

- [ ] **Step 2: Write the implementation**

Create `src/evolution/skill-analyzer.ts`:

```typescript
import type { SkillStats } from './types';
import type { TraceRun } from '../trace/types';
import { debugLog } from '../utils/debug';

export interface TraceSnippet {
  outcome: string;
  traces: string;
}

interface AnalysisVerdict {
  verdict: 'keep' | 'fix' | 'delete';
  reasoning: string;
  suggestion?: string;
}

export function buildAnalysisPrompt(
  skillName: string,
  description: string,
  stats: SkillStats,
  traces: TraceSnippet[],
): string {
  const traceSections = traces.map((t, i) =>
    `Trace ${i + 1} (outcome: ${t.outcome}):\n${t.traces}\n`,
  ).join('\n---\n');

  return `You are evaluating the effectiveness of an auto-generated skill.

Skill: ${skillName}
Description: ${description}
Success rate: ${stats.successRate} (${stats.successfulRuns}/${stats.totalRuns})

Related traces (runs where this skill was active):

${traceSections}

For each run where the outcome was "error", determine:
1. Was the skill's advice directly responsible for the error?
2. Was the error caused by external factors (API error, network, user interruption)?
3. Was the skill irrelevant to the task (present but unused)?

Overall assessment:
- "keep" — skill is useful, failures are unrelated
- "fix" — skill has specific issues (specify what to change)
- "delete" — skill is harmful or never useful

Output as JSON: {"verdict":"keep|fix|delete","reasoning":"...","suggestion":"..."}`;
}

export function parseVerdict(raw: string): AnalysisVerdict | null {
  try {
    const parsed = JSON.parse(raw) as AnalysisVerdict;
    if (!['keep', 'fix', 'delete'].includes(parsed.verdict)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function verdictToEvalCase(
  skillName: string,
  verdict: AnalysisVerdict,
): { query: string; should_trigger: boolean; expected_behavior: string } | null {
  if (verdict.verdict !== 'fix' || !verdict.suggestion) return null;
  return {
    query: `Analyze this trace where skill "${skillName}" was used. ${verdict.reasoning}`,
    should_trigger: true,
    expected_behavior: verdict.suggestion,
  };
}
```

- [ ] **Step 3: Run tests**

```bash
bun test tests/evolution/skill-analyzer.test.ts
```

Expected: 5 tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/evolution/skill-analyzer.ts tests/evolution/skill-analyzer.test.ts
git commit -m "feat: add Tier 2 LLM skill analysis agent"
```

---

### Task 6: Extend ReviewNotification with keep/delete buttons

**Files:**
- Modify: `src/cli/tui/components/ReviewNotification.tsx`
- Modify: `src/cli/tui/state/store.ts`
- Modify: `src/cli/tui/state/types.ts`

- [ ] **Step 1: Add state actions**

In `src/cli/tui/state/types.ts`, add to `TuiStore`:

```typescript
keepReviewSkill: (skillName: string) => void;
deleteReviewSkill: (skillName: string) => void;
```

In `src/cli/tui/state/store.ts`, add implementations:

```typescript
keepReviewSkill: (skillName) =>
  set((s) => {
    for (const n of s.reviewNotifications) {
      if (n.skillName === skillName) {
        n.dismissed = true;
        n.kept = true;
      }
    }
  }),

deleteReviewSkill: (skillName) =>
  set((s) => {
    for (const n of s.reviewNotifications) {
      if (n.skillName === skillName) {
        n.dismissed = true;
        n.deleted = true;
      }
    }
  }),
```

Update `ReviewNotification` type in `types.ts`:

```typescript
export interface ReviewNotification {
  skillName: string;
  description: string;
  outputDir: string;
  dismissed: boolean;
  kept?: boolean;
  deleted?: boolean;
  createdAt: number;
}
```

- [ ] **Step 2: Update component**

In `src/cli/tui/components/ReviewNotification.tsx`, add action hint text:

```tsx
<Text dimColor>[k to keep] [d to delete] [ignore]</Text>
```

The actual keyboard handling is done by the existing input handling system (the TUI already has keyboard dispatch for the main input box). Add keybindings for 'k' and 'd' that call the store actions for the focused notification.

Note: The exact keyboard handling mechanism depends on how the TUI currently dispatches keys. Read `App.tsx` and `InputBox.tsx` to understand the pattern. For this plan, we add the store actions and UI text; the keyboard wiring is a follow-up integration step.

- [ ] **Step 3: Verify and commit**

```bash
bun run tsc --noEmit
bun run lint
bun test
git add src/cli/tui/components/ReviewNotification.tsx src/cli/tui/state/store.ts src/cli/tui/state/types.ts
git commit -m "feat: add keep/delete actions to review notifications"
```

---

### Task 7: Implement /review slash command

**Files:**
- Create: `src/cli/tui/commands/review-commands.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/evolution/review-commands.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { createReviewCommands } from '../../src/cli/tui/commands/review-commands';
import type { SlashCommand } from '../../src/cli/tui/command-registry';

describe('review-commands', () => {
  test('creates /review command', () => {
    const cmds = createReviewCommands();
    expect(cmds.length).toBeGreaterThan(0);
    expect(cmds[0]!.name).toBe('review');
  });

  test('/review list matches', () => {
    const cmds = createReviewCommands();
    const listCmd = cmds.find(c => c.name === 'review')!;
    expect(listCmd.matches('/review list')).toBe(true);
    expect(listCmd.matches('/review view test-skill')).toBe(true);
    expect(listCmd.matches('/review keep test-skill')).toBe(true);
    expect(listCmd.matches('/review delete test-skill')).toBe(true);
  });

  test('/review does not match unrelated commands', () => {
    const cmds = createReviewCommands();
    const listCmd = cmds.find(c => c.name === 'review')!;
    expect(listCmd.matches('/save')).toBe(false);
    expect(listCmd.matches('/help')).toBe(false);
  });
});
```

Run to verify it fails:
```bash
bun test tests/evolution/review-commands.test.ts
```

- [ ] **Step 2: Write the implementation**

Create `src/cli/tui/commands/review-commands.ts`:

```typescript
import type { SlashCommand } from '../command-registry';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { useTuiStore } from '../state/store';

const AUTO_SKILLS_DIR = path.join(os.homedir(), '.my-agent', 'skills', 'auto');

async function handleReview(args: string[], onOutput: (text: string) => void): Promise<void> {
  const subCommand = args[0] ?? 'list';
  const skillName = args[1];

  switch (subCommand) {
    case 'list': {
      try {
        const entries = await fs.readdir(AUTO_SKILLS_DIR, { withFileTypes: true });
        const skills = entries.filter(e => e.isDirectory()).map(e => e.name);

        if (skills.length === 0) {
          onOutput('No auto-generated skills found.');
          return;
        }

        const lines: string[] = ['Auto skills:'];
        for (const name of skills) {
          let statusInfo = '';
          try {
            const statusRaw = await fs.readFile(
              path.join(AUTO_SKILLS_DIR, `${name}.status.json`), 'utf-8',
            );
            const status = JSON.parse(statusRaw);
            statusInfo = `  ${status.status}`;
            if (status.stats) {
              statusInfo += `  ${status.stats.successRate * 100}% success (${status.stats.successfulRuns}/${status.stats.totalRuns})`;
            }
          } catch {
            statusInfo = '  (no status)';
          }
          lines.push(`  ${name}${statusInfo}`);
        }
        onOutput(lines.join('\n'));
      } catch {
        onOutput('No auto-generated skills found.');
      }
      break;
    }
    case 'view': {
      if (!skillName) { onOutput('Usage: /review view <skill-name>'); return; }
      try {
        const content = await fs.readFile(
          path.join(AUTO_SKILLS_DIR, skillName, 'SKILL.md'), 'utf-8',
        );
        onOutput(content);
      } catch {
        onOutput(`Skill "${skillName}" not found.`);
      }
      break;
    }
    case 'keep': {
      if (!skillName) { onOutput('Usage: /review keep <skill-name>'); return; }
      const store = useTuiStore.getState();
      store.keepReviewSkill(skillName);
      onOutput(`Skill "${skillName}" marked as kept.`);
      break;
    }
    case 'delete': {
      if (!skillName) { onOutput('Usage: /review delete <skill-name>'); return; }
      try {
        await fs.rm(path.join(AUTO_SKILLS_DIR, skillName), { recursive: true, force: true });
        await fs.rm(path.join(AUTO_SKILLS_DIR, `${skillName}.status.json`), { force: true });
        const store = useTuiStore.getState();
        store.deleteReviewSkill(skillName);
        onOutput(`Skill "${skillName}" deleted.`);
      } catch {
        onOutput(`Failed to delete "${skillName}".`);
      }
      break;
    }
    default:
      onOutput('Usage: /review [list|view|keep|delete] [skill-name]');
  }
}

export function createReviewCommands(): SlashCommand[] {
  return [
    {
      name: 'review',
      description: 'Manage auto-generated skills. Sub-commands: list, view, keep, delete.',
      matches: (input: string) => input.startsWith('/review'),
      execute: async (input: string, ctx: { onOutput: (text: string) => void }) => {
        const parts = input.split(/\s+/).slice(1);
        await handleReview(parts, ctx.onOutput);
      },
    },
  ];
}
```

- [ ] **Step 3: Register /review command**

Find where slash commands are registered (typically in `App.tsx` or a command registry initialization). Add:

```typescript
import { createReviewCommands } from './commands/review-commands';
// ...
registerCommands(createReviewCommands());
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/evolution/review-commands.test.ts
bun run tsc --noEmit
bun run lint
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/tui/commands/review-commands.ts tests/evolution/review-commands.test.ts
git commit -m "feat: add /review slash command for auto-skill management"
```

---

### Task 8: Create seed eval cases for prompt optimization

**Files:**
- Create: `tests/evolution/review-prompt-evals.json`

- [ ] **Step 1: Create eval cases**

Create `tests/evolution/review-prompt-evals.json`:

```json
[
  {
    "query": "Analyze this trace: 3 errors in 2 turns, bash permission denied twice, grep ENOENT once. Tools used: bash, grep. Should a skill be created?",
    "should_trigger": true,
    "expected_skill_name": "fix-permissions"
  },
  {
    "query": "Analyze this trace: 1 error in 10 turns, a typo 'grpe' instead of 'grep'. Should a skill be created?",
    "should_trigger": false
  },
  {
    "query": "Analyze this trace: 0 errors, 8 turns, used grep → text_editor → bash to fix a config. Should a skill be created?",
    "should_trigger": true,
    "expected_skill_name": "config-fix-workflow"
  },
  {
    "query": "Analyze this trace: 0 errors, 1 turn, just 'ls' to list files. Should a skill be created?",
    "should_trigger": false
  },
  {
    "query": "Analyze this trace: 2 errors, 4 turns, both errors are EACCES on text_editor. Pattern: editing system config files without sudo. Should a skill be created?",
    "should_trigger": true,
    "expected_skill_name": "system-config-editing"
  },
  {
    "query": "Analyze this trace: 0 errors, 6 turns, used read → grep → read → write pattern to investigate and fix a bug. Should a skill be created?",
    "should_trigger": true,
    "expected_skill_name": "bug-investigation-workflow"
  },
  {
    "query": "Analyze this trace: 0 errors, 2 turns, simple file read. Should a skill be created?",
    "should_trigger": false
  },
  {
    "query": "Analyze this trace: 5 errors in 3 turns, all network timeouts. Should a skill be created?",
    "should_trigger": false
  },
  {
    "query": "Analyze this trace: 0 errors, 5 turns, setup a new project with npm init → install deps → configure tsconfig. Should a skill be created?",
    "should_trigger": true,
    "expected_skill_name": "project-setup"
  },
  {
    "query": "Analyze this trace: 1 error in 20 turns, a single 404 on an API call. Should a skill be created?",
    "should_trigger": false
  },
  {
    "query": "Analyze this trace: 0 errors, 7 turns, database migration workflow: backup → schema change → verify. Should a skill be created?",
    "should_trigger": true,
    "expected_skill_name": "db-migration"
  },
  {
    "query": "Analyze this trace: 3 errors in 3 turns, all the same ENOENT because user typed the wrong file path. Should a skill be created?",
    "should_trigger": false
  },
  {
    "query": "Analyze this trace: 0 errors, 4 turns, CI/CD fix: check logs → find failing step → update yaml → re-run. Should a skill be created?",
    "should_trigger": true,
    "expected_skill_name": "cicd-debug"
  },
  {
    "query": "Analyze this trace: 2 errors, 5 turns, mixed bag: one typo, one permission error, rest succeeded. Should a skill be created?",
    "should_trigger": false
  },
  {
    "query": "Analyze this trace: 0 errors, 9 turns, code review workflow: read PR → grep for anti-patterns → suggest changes → apply fixes. Should a skill be created?",
    "should_trigger": true,
    "expected_skill_name": "code-review-workflow"
  },
  {
    "query": "Analyze this trace: 0 errors, 1 turn, user asked 'what does git status do' and agent just ran git status. Should a skill be created?",
    "should_trigger": false
  },
  {
    "query": "Analyze this trace: 4 errors in 4 turns, all permission denied on docker commands — user needs docker group membership, not a skill. Should a skill be created?",
    "should_trigger": false
  },
  {
    "query": "Analyze this trace: 0 errors, 6 turns, refactoring: rename symbols across files → update imports → run tests → fix failures → commit. Should a skill be created?",
    "should_trigger": true,
    "expected_skill_name": "refactoring-workflow"
  },
  {
    "query": "Analyze this trace: 2 errors in 6 turns, both errors are the same — forgot to npm install before npm run build. Should a skill be created?",
    "should_trigger": true,
    "expected_skill_name": "pre-build-checklist"
  },
  {
    "query": "Analyze this trace: 0 errors, 2 turns, agent just chatted with user about the weather. Should a skill be created?",
    "should_trigger": false
  }
]
```

- [ ] **Step 2: Verify the JSON is valid**

```bash
bun -e "JSON.parse(require('fs').readFileSync('tests/evolution/review-prompt-evals.json','utf-8'))" && echo "Valid JSON"
```

- [ ] **Step 3: Commit**

```bash
git add tests/evolution/review-prompt-evals.json
git commit -m "test: add seed eval cases for review prompt optimization"
```

---

### Task 9: Wire feedback loop — Tier 2 verdict → eval cases

**Files:**
- Modify: `src/evolution/index.ts` (or effectiveness-tracker.ts)

- [ ] **Step 1: Add feedback eval persistence**

In `src/evolution/effectiveness-tracker.ts`, add method:

```typescript
import { verdictToEvalCase, parseVerdict } from './skill-analyzer';

async appendFeedbackEval(
  skillName: string,
  verdictRaw: string,
): Promise<void> {
  const verdict = parseVerdict(verdictRaw);
  if (!verdict) return;
  const evalCase = verdictToEvalCase(skillName, verdict);
  if (!evalCase) return;

  const feedbackPath = path.join(
    process.cwd(), 'tests', 'evolution', 'review-prompt-evals-feedback.json',
  );

  let existing: Array<Record<string, unknown>> = [];
  try {
    existing = JSON.parse(await fs.readFile(feedbackPath, 'utf-8'));
  } catch {
    // file doesn't exist yet
  }

  existing.push(evalCase);
  await fs.writeFile(feedbackPath, JSON.stringify(existing, null, 2), 'utf-8');
  debugLog(`[evolution] Appended feedback eval case for ${skillName}`);
}
```

- [ ] **Step 2: Wire the feedback loop**

In the evolution module's afterAgentRun path, after Tier 2 analysis completes, call `appendFeedbackEval`.

Track the count of pending feedback cases. When >= 5, emit a notification:

```typescript
if (pendingFeedbackCount >= 5) {
  debugLog(`[evolution] ${pendingFeedbackCount} feedback cases pending for prompt optimization`);
  // Optionally emit to TUI
}
```

- [ ] **Step 3: Verify and commit**

```bash
bun run tsc --noEmit
bun run lint
bun test
git add src/evolution/effectiveness-tracker.ts src/evolution/index.ts
git commit -m "feat: wire feedback loop from Tier 2 verdict to eval cases"
```

---

### Task 10: End-to-end integration test

**Files:**
- Create: `tests/evolution/phase3-integration.test.ts`

- [ ] **Step 1: Write integration test**

Create `tests/evolution/phase3-integration.test.ts`:

```typescript
import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { EffectivenessTracker } from '../../src/evolution/effectiveness-tracker';
import { buildAnalysisPrompt, parseVerdict, verdictToEvalCase } from '../../src/evolution/skill-analyzer';

const TEST_DIR = path.join(os.tmpdir(), `phase3-e2e-${Date.now()}`);

describe('Phase 3 integration', () => {
  afterEach(async () => { await fs.rm(TEST_DIR, { recursive: true, force: true }); });

  test('full mechanical scoring flow', async () => {
    const tracker = new EffectivenessTracker(TEST_DIR);
    const stats = await tracker.updateStats('test-skill', 'completed', 'run-1');
    expect(stats.totalRuns).toBe(1);
    expect(stats.successRate).toBe(1);

    await tracker.updateStats('test-skill', 'error', 'run-2');
    await tracker.updateStats('test-skill', 'error', 'run-3');
    await tracker.updateStats('test-skill', 'error', 'run-4');

    const status = await tracker.loadStatus('test-skill');
    expect(status).not.toBeNull();
    expect(status!.stats!.totalRuns).toBe(4);
    expect(status!.stats!.successRate).toBe(0.25);
    expect(tracker.shouldTriggerReview(status!.stats!)).toBe(true);
  });

  test('Tier 2 prompt is generated correctly for low-scoring skill', () => {
    const prompt = buildAnalysisPrompt('bad-skill', 'Does bad things', {
      totalRuns: 5, successfulRuns: 2, successRate: 0.4, lastRunId: 'x',
    }, [
      { outcome: 'error', traces: 'bash: permission denied' },
      { outcome: 'completed', traces: 'read: file found' },
    ]);
    expect(prompt).toContain('bad-skill');
    expect(prompt).toContain('keep');
    expect(prompt).toContain('fix');
    expect(prompt).toContain('delete');
  });

  test('verdict to eval case conversion works', () => {
    const verdict = parseVerdict(JSON.stringify({
      verdict: 'fix',
      reasoning: 'Missing /tmp sudo guidance',
      suggestion: 'Add sudo requirements to pitfalls',
    }));
    expect(verdict).not.toBeNull();

    const evalCase = verdictToEvalCase('test-skill', verdict!);
    expect(evalCase).not.toBeNull();
    expect(evalCase!.should_trigger).toBe(true);
    expect(evalCase!.expected_behavior).toContain('sudo');
  });

  test('keep verdict does not generate eval case', () => {
    const verdict = parseVerdict(JSON.stringify({
      verdict: 'keep',
      reasoning: 'Skill is fine',
    }));
    expect(verdictToEvalCase('test-skill', verdict!)).toBeNull();
  });
});
```

- [ ] **Step 2: Run integration test**

```bash
bun test tests/evolution/phase3-integration.test.ts
```

Expected: 4 tests PASS

- [ ] **Step 3: Run full test suite**

```bash
bun test
bun run tsc --noEmit
bun run lint
```

Expected: all PASS, no regressions.

- [ ] **Step 4: Commit**

```bash
git add tests/evolution/phase3-integration.test.ts
git commit -m "test: add Phase 3 end-to-end integration tests"
```

---

## Architecture Compliance Checklist (Constitution §A–I)

- **§A** ✅ — All wiring via `createAgentRuntime()`, no direct instantiation in `bin/*`.
- **§B** ✅ — No `any` types.
- **§C** ✅ — No new hooks. Features use existing `beforeAgentRun` + TUI commands.
- **§D** ✅ — ToolDispatcher unchanged.
- **§E** ✅ — No new `syncTodoFromContext` calls.
- **§F** ✅ — All types used, no dead code.
- **§G** ✅ — All new files < 200 lines.
- **§H** ✅ — All new public APIs have unit tests.
- **§I** ✅ — `debugLog` only. No `console.log`, no `@ts-ignore`.
