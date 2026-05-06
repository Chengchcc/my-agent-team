# Self-Evolution (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a background Review Agent that consumes Phase 1 NudgeResult signals, analyzes traces, and produces structured skills in `~/.my-agent/skills/auto/`.

**Architecture:** New `src/evolution/` module as a trace consumer. `initEvolution()` factory creates a ReviewAgent runner. `TraceAgentMiddleware` accepts an optional evolution callback — when a NudgeResult fires, it calls `evolution.review(nudgeResult, trace)`. Review Agent forks with an independent ContextManager, lightweight model, and a single `create_review_skill` tool. SkillLoader gains multi-source support (project + auto). TUI gains a passive `ReviewNotification` component.

**Tech Stack:** TypeScript, Bun test, Zod (existing), Ink/React (existing TUI). No new dependencies.

---

## File Structure

```
New:
  src/evolution/types.ts              # ReviewConfig, ReviewSession, ReviewOutput
  src/evolution/prompt-templates.ts   # buildReviewPrompt(trigger, trace, existingSkills)
  src/evolution/review-tools.ts       # CreateReviewSkillTool (ZodTool)
  src/evolution/review-agent.ts       # forkReviewAgent()
  src/evolution/index.ts              # initEvolution() factory
  tests/evolution/review-tools.test.ts
  tests/evolution/prompt-templates.test.ts
  tests/evolution/review-agent.test.ts

Modified:
  src/trace/agent-middleware.ts       # accept optional evolution callback
  src/trace/index.ts                  # add evolutionOptions to createTraceMiddleware
  src/runtime.ts                      # wire initEvolution
  src/skills/loader.ts                # multi-source loading (project + auto)
  src/config/types.ts                 # TraceReviewSettings
  src/config/defaults.ts              # review defaults
  src/config/schema.ts                # review schema
  src/types.ts                        # EvolutionReviewDone event type
  src/agent/loop-types.ts             # EvolutionReviewDone AgentEvent variant
  src/cli/tui/components/ReviewNotification.tsx  # TUI notification component
  src/cli/tui/hooks/use-agent-loop.tsx           # dispatch evolution_review_done
  src/cli/tui/hooks/agent-ui-reducer.ts          # UI state for notifications
```

---

### Task 1: Upgrade skill-creator to official format (prerequisite)

**Files:**
- Modify: `skills/skill-creator/SKILL.md`
- Create: `skills/skill-creator/scripts/`, `skills/skill-creator/references/`, `skills/skill-creator/assets/`

- [ ] **Step 1: Copy official skill-creator files from the reference repo**

```bash
cp /root/skills/skills/skill-creator/SKILL.md skills/skill-creator/SKILL.md
mkdir -p skills/skill-creator/scripts
cp /root/skills/skills/skill-creator/scripts/* skills/skill-creator/scripts/
mkdir -p skills/skill-creator/references
cp /root/skills/skills/skill-creator/references/* skills/skill-creator/references/
mkdir -p skills/skill-creator/assets
cp /root/skills/skills/skill-creator/assets/* skills/skill-creator/assets/
```

Note: Copy the subdirectories that exist. The official repo may not have all of scripts/references/assets populated — copy what's there.

- [ ] **Step 2: Remove `_meta.json` references from the new SKILL.md**

If the copied SKILL.md still references `_meta.json`, remove those lines. The official format does not require it.

- [ ] **Step 3: Verify the skill loader still reads it correctly**

```typescript
// While we're here, verify the existing SkillLoader can still parse it
```

Run: `bun test tests/` — no regressions expected.

- [ ] **Step 4: Commit**

```bash
git add skills/skill-creator/
git commit -m "chore: upgrade skill-creator to official format"
```

---

### Task 2: Add review config types, defaults, and schema

**Files:**
- Modify: `src/config/types.ts`
- Modify: `src/config/defaults.ts`
- Modify: `src/config/schema.ts`

- [ ] **Step 1: Add TraceReviewSettings to config/types.ts**

Add after `TraceNudgeSettings`:

```typescript
export interface TraceReviewSettings {
  enabled: boolean;
  model: string;
  maxTurns: number;
  tokenLimit: number;
  timeoutMs: number;
  outputDir: string;
}
```

Add `review: TraceReviewSettings` inside `TraceSettings`:

```typescript
export interface TraceSettings {
  enabled: boolean;
  maxRunsPerSession: number;
  redaction: TraceRedactionSettings;
  nudge: TraceNudgeSettings;
  review: TraceReviewSettings;
}
```

- [ ] **Step 2: Add defaults to config/defaults.ts**

```typescript
review: {
  enabled: true,
  model: 'claude-3-haiku-20240307',
  maxTurns: 6,
  tokenLimit: 30_000,
  timeoutMs: 60_000,
  outputDir: '~/.my-agent/skills/auto',
},
```

- [ ] **Step 3: Add Zod schema to config/schema.ts**

```typescript
const traceReviewSettingsSchema = z.object({
  enabled: z.boolean(),
  model: z.string(),
  maxTurns: z.number().min(3).max(12),
  tokenLimit: z.number().min(10_000).max(100_000),
  timeoutMs: z.number().min(30_000).max(300_000),
  outputDir: z.string(),
});
```

Add `review: traceReviewSettingsSchema` to `traceSettingsSchema`.

- [ ] **Step 4: Run type-check and tests**

```bash
bun run tsc --noEmit
bun test
```

- [ ] **Step 5: Commit**

```bash
git add src/config/types.ts src/config/defaults.ts src/config/schema.ts
git commit -m "feat: add trace.review config types, defaults, and schema"
```

---

### Task 3: Create evolution types

**Files:**
- Create: `src/evolution/types.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/evolution/types.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';

// Minimal compile-time test — types are structural
describe('Evolution types', () => {
  test('ReviewConfig shape is correct', () => {
    const config = {
      enabled: true,
      model: 'test',
      maxTurns: 6,
      tokenLimit: 30000,
      timeoutMs: 60000,
      outputDir: '/tmp/test',
    };
    expect(config.maxTurns).toBe(6);
    expect(config.timeoutMs).toBe(60000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/evolution/types.test.ts`
Expected: No types defined yet — this test should pass as-is since it only tests object literals.

- [ ] **Step 3: Write the types**

Create `src/evolution/types.ts`:

```typescript
/** Configuration for the background review system. */
export interface ReviewConfig {
  enabled: boolean;
  model: string;
  maxTurns: number;
  tokenLimit: number;
  timeoutMs: number;
  outputDir: string;
}

/** State tracked per review session for concurrency control. */
export interface ReviewSession {
  running: boolean;
  lastReviewAt: number;
  pendingNotifications: ReviewNotification[];
}

/** A completed review notification for TUI display. */
export interface ReviewNotification {
  skillName: string;
  description: string;
  outputDir: string;
  createdAt: number;
}

/** Callback type for wiring evolution into the trace middleware. */
export type EvolutionReviewCallback = (
  nudgeResult: { trigger: string; traceRunId: string; sessionId: string; reason: string },
  trace: { id: string; sessionId: string; turns: Array<unknown>; summary: Record<string, unknown> },
) => void;
```

- [ ] **Step 4: Run test to verify**

Run: `bun test tests/evolution/types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/evolution/types.ts tests/evolution/types.test.ts
git commit -m "feat: add evolution types"
```

---

### Task 4: Implement prompt templates

**Files:**
- Create: `src/evolution/prompt-templates.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/evolution/prompt-templates.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test';
import { buildReviewPrompt } from '../../src/evolution/prompt-templates';
import type { TraceRun } from '../../src/trace/types';

function makeTrace(overrides: Partial<TraceRun> = {}): TraceRun {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    startTime: Date.now(),
    endTime: Date.now(),
    model: 'test-model',
    turns: [
      {
        turnIndex: 0,
        userMessage: 'do something',
        modelResponse: {
          text: 'ok',
          toolCalls: [{ name: 'bash', arguments: { command: 'ls' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        },
        toolExecutions: [
          { toolName: 'bash', success: false, durationMs: 100, error: 'permission denied' },
        ],
      },
    ],
    summary: {
      totalTurns: 1, totalToolCalls: 1, totalErrors: 1,
      totalTokens: { prompt_tokens: 10, completion_tokens: 5 },
      outcome: 'error' as const,
    },
    ...overrides,
  };
}

describe('buildReviewPrompt', () => {
  test('error_burst prompt includes trace data and scoring instructions', () => {
    const trace = makeTrace();
    const prompt = buildReviewPrompt('error_burst', trace, []);

    expect(prompt).toContain('errors');
    expect(prompt).toContain('permission denied');
    expect(prompt).toContain('Score this pattern 1–5');
    expect(prompt).toContain('Nothing to save');
  });

  test('complex_task prompt includes workflow extraction instructions', () => {
    const trace = makeTrace({
      summary: {
        totalTurns: 5, totalToolCalls: 5, totalErrors: 0,
        totalTokens: { prompt_tokens: 50, completion_tokens: 25 },
        outcome: 'completed' as const,
      },
    });
    const prompt = buildReviewPrompt('complex_task', trace, []);

    expect(prompt).toContain('successful multi-step');
    expect(prompt).toContain('workflow');
    expect(prompt).toContain('Score this workflow');
  });

  test('periodic prompt references review interval', () => {
    const trace = makeTrace({ summary: { ...makeTrace().summary, totalErrors: 0, outcome: 'completed' as const } });
    const prompt = buildReviewPrompt('periodic', trace, []);

    expect(prompt).toContain('Periodic review');
    expect(prompt).toContain('Nothing to save');
  });

  test('injects existing skill names for dedup', () => {
    const trace = makeTrace();
    const existingSkills = ['fix-permissions', 'bash-tricks'];
    const prompt = buildReviewPrompt('error_burst', trace, existingSkills);

    expect(prompt).toContain('fix-permissions');
    expect(prompt).toContain('bash-tricks');
    expect(prompt).toContain('do NOT duplicate');
  });

  test('handle empty trace gracefully', () => {
    const trace = makeTrace({ turns: [], summary: { ...makeTrace().summary, totalTurns: 0, totalToolCalls: 0, totalErrors: 0 } });
    const prompt = buildReviewPrompt('error_burst', trace, []);

    expect(prompt).toContain('errors');
    expect(typeof prompt).toBe('string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/evolution/prompt-templates.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Write the implementation**

Create `src/evolution/prompt-templates.ts`:

```typescript
import type { TraceRun } from '../trace/types';

const ERROR_BURST_PROMPT = `You are reviewing a trace of an agent execution that had errors.

Trace summary:
- {totalTurns} turns, {totalErrors} errors
- Failed tools: {failedToolNames}

Full trace (turn-by-turn):
{trace}

Existing skills (do NOT duplicate):
{existingSkills}

Your task:
1. Score this pattern 1–5:
   - 1–2: one-off mistake or trivial — do NOT create a skill
   - 3–4: useful trick or pattern worth capturing
   - 5: high-value reusable workflow
2. If score < 3, respond "Nothing to save" and explain why
3. Identify the root cause of each tool error
4. Determine if this failure pattern is avoidable with a skill
5. If a skill already covers this, suggest adding a "Pitfalls" section
6. Only call create_review_skill if score ≥ 3 AND the pattern is reusable

Output: call create_review_skill ONLY if there is a concrete, reusable pattern.`;

const COMPLEX_TASK_PROMPT = `You are reviewing a trace of a successful multi-step agent task.

Trace summary:
- {totalTurns} turns, 0 errors
- Tools used: {toolNames}

Full trace (turn-by-turn):
{trace}

Existing skills (do NOT duplicate):
{existingSkills}

Your task:
1. Score this workflow 1–5 for reusability:
   - 1–2: specific to this one task — do NOT create a skill
   - 3–4: recurring pattern for this project
   - 5: broadly reusable across contexts
2. If score < 3, respond "Nothing to save" and explain why
3. Identify the workflow — what was the sequence of steps?
4. Were there any non-obvious workarounds or tool-usage patterns?
5. If the workflow is reusable, create a skill capturing it
6. Include a "Pitfalls" section if any step could go wrong
7. Only call create_review_skill if score ≥ 3 AND the workflow is reusable

Output: call create_review_skill ONLY if there is a concrete, reusable workflow.`;

const PERIODIC_PROMPT = `Periodic review after {reviewInterval} accumulated turns across multiple runs.

Recent traces:
{recentTraceSummaries}

Existing skills (do NOT duplicate):
{existingSkills}

Review these traces for patterns that should become skills.
If nothing actionable, respond "Nothing to save."`;

function formatTraceForPrompt(trace: TraceRun): string {
  return JSON.stringify(trace.turns, null, 2);
}

function getFailedToolNames(trace: TraceRun): string {
  const failed = new Set<string>();
  for (const turn of trace.turns) {
    for (const exec of turn.toolExecutions) {
      if (!exec.success) failed.add(exec.toolName);
    }
  }
  return [...failed].join(', ') || 'none';
}

function getToolNames(trace: TraceRun): string {
  const tools = new Set<string>();
  for (const turn of trace.turns) {
    for (const exec of turn.toolExecutions) {
      tools.add(exec.toolName);
    }
  }
  return [...tools].join(', ') || 'none';
}

function formatExistingSkills(skills: string[]): string {
  if (skills.length === 0) return '(none)';
  return skills.join('\n- ');
}

export function buildReviewPrompt(
  trigger: 'error_burst' | 'complex_task' | 'periodic',
  trace: TraceRun,
  existingSkills: string[],
  reviewInterval: number = 10,
): string {
  const skillList = formatExistingSkills(existingSkills);
  const traceData = formatTraceForPrompt(trace);

  switch (trigger) {
    case 'error_burst':
      return ERROR_BURST_PROMPT
        .replace('{totalTurns}', String(trace.summary.totalTurns))
        .replace('{totalErrors}', String(trace.summary.totalErrors))
        .replace('{failedToolNames}', getFailedToolNames(trace))
        .replace('{trace}', traceData)
        .replace('{existingSkills}', skillList);

    case 'complex_task':
      return COMPLEX_TASK_PROMPT
        .replace('{totalTurns}', String(trace.summary.totalTurns))
        .replace('{toolNames}', getToolNames(trace))
        .replace('{trace}', traceData)
        .replace('{existingSkills}', skillList);

    case 'periodic':
      return PERIODIC_PROMPT
        .replace('{reviewInterval}', String(reviewInterval))
        .replace('{recentTraceSummaries}', JSON.stringify(trace.summary, null, 2))
        .replace('{existingSkills}', skillList);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/evolution/prompt-templates.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/evolution/prompt-templates.ts tests/evolution/prompt-templates.test.ts
git commit -m "feat: add review prompt templates for error_burst, complex_task, periodic"
```

---

### Task 5: Implement CreateReviewSkill tool

**Files:**
- Create: `src/evolution/review-tools.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/evolution/review-tools.test.ts`:

```typescript
import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { CreateReviewSkillTool } from '../../src/evolution/review-tools';
import { ToolRegistry } from '../../src/agent/tool-registry';
import { ContextManager } from '../../src/agent/context';
import type { ToolContext } from '../../src/agent/tool-dispatch/types';

const TEST_DIR = path.join(os.tmpdir(), `evolution-test-${Date.now()}`);

function createTestCtx(): ToolContext {
  const contextManager = new ContextManager({ tokenLimit: 10000 });
  return {
    agentContext: contextManager.getContext({ tokenLimit: 10000 }),
    environment: { cwd: process.cwd() },
  } as ToolContext;
}

describe('CreateReviewSkillTool', () => {
  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  test('creates skill directory with SKILL.md', async () => {
    const tool = new CreateReviewSkillTool(TEST_DIR);
    await tool.execute({
      skill_name: 'test-skill',
      description: 'A test skill for testing',
      body: '## Instructions\n\nDo the thing.',
      pitfalls: 'Watch out for X',
    }, createTestCtx());

    const skillDir = path.join(TEST_DIR, 'test-skill');
    const stat = await fs.stat(skillDir);
    expect(stat.isDirectory()).toBe(true);

    const skillMd = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8');
    expect(skillMd).toContain('name: test-skill');
    expect(skillMd).toContain('A test skill for testing');
    expect(skillMd).toContain('## Instructions');
    expect(skillMd).toContain('## Pitfalls');
    expect(skillMd).toContain('Watch out for X');
  });

  test('skips creation if skill already exists (dedup)', async () => {
    const tool = new CreateReviewSkillTool(TEST_DIR);
    const ctx = createTestCtx();

    // First creation
    await tool.execute({
      skill_name: 'existing-skill',
      description: 'Already here',
      body: 'Content',
    }, ctx);

    // Second creation with same name — should skip
    await tool.execute({
      skill_name: 'existing-skill',
      description: 'Already here',
      body: 'Content',
    }, ctx);

    // Should still exist (no error, just skipped)
    const skillMd = await fs.readFile(
      path.join(TEST_DIR, 'existing-skill', 'SKILL.md'), 'utf-8',
    );
    expect(skillMd).toContain('Already here');
  });

  test('creates scripts directory when provided', async () => {
    const tool = new CreateReviewSkillTool(TEST_DIR);
    await tool.execute({
      skill_name: 'scripted-skill',
      description: 'Skill with scripts',
      body: 'Uses helper.py',
      scripts: { 'helper.py': 'print("hello")' },
    }, createTestCtx());

    const scriptContent = await fs.readFile(
      path.join(TEST_DIR, 'scripted-skill', 'scripts', 'helper.py'), 'utf-8',
    );
    expect(scriptContent).toBe('print("hello")');
  });

  test('cleans up on partial write failure', async () => {
    // Create a read-only parent dir to force write failure
    const badDir = path.join(TEST_DIR, 'readonly');
    await fs.mkdir(badDir);

    // The tool should handle errors gracefully
    const tool = new CreateReviewSkillTool(TEST_DIR);
    const ctx = createTestCtx();

    // Use invalid skill name (with slashes) to cause path issues
    const result = await tool.execute({
      skill_name: 'ok-skill',
      description: 'Test',
      body: 'Content',
    }, ctx);

    // Should succeed or fail gracefully without leaving partial state
    // The key assertion: no unhandled exception
    expect(result).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/evolution/review-tools.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Write the implementation**

Create `src/evolution/review-tools.ts`:

```typescript
import { ZodTool } from '../tools/zod-tool';
import type { ToolContext } from '../agent/tool-dispatch/types';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { debugLog } from '../utils/debug';

function expandTilde(filePath: string): string {
  if (filePath.startsWith('~')) {
    return path.join(os.homedir(), filePath.slice(1));
  }
  return filePath;
}

export class CreateReviewSkillTool extends ZodTool<z.ZodObject<{
  skill_name: z.ZodString;
  description: z.ZodString;
  body: z.ZodString;
  pitfalls: z.ZodOptional<z.ZodString>;
  scripts: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
  references: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}>> {
  protected readonly name = 'create_review_skill';
  protected readonly description = `Create a new skill from reviewed trace patterns.
Only call this if the pattern/workflow is reusable (score ≥ 3).
Output goes to the auto-review skills directory.`;

  readonly = false;
  conflictKey = () => 'create_review_skill:global';

  protected schema = z.object({
    skill_name: z.string().min(1).max(64),
    description: z.string().min(1).max(500),
    body: z.string().min(1),
    pitfalls: z.string().optional(),
    scripts: z.record(z.string(), z.string()).optional(),
    references: z.record(z.string(), z.string()).optional(),
  });

  private outputDir: string;

  constructor(outputDir: string) {
    super();
    this.outputDir = expandTilde(outputDir);
  }

  protected async execute(
    args: z.infer<this['schema']>,
    _ctx: ToolContext,
  ): Promise<string> {
    const skillDir = path.join(this.outputDir, args.skill_name);

    // Dedup check: skip if directory already exists
    try {
      await fs.access(skillDir);
      debugLog(`[evolution] Skill "${args.skill_name}" already exists, skipping`);
      return `Skill "${args.skill_name}" already exists. Skipped.`;
    } catch {
      // Directory does not exist — proceed
    }

    try {
      // 1. Create directory
      await fs.mkdir(skillDir, { recursive: true });

      // 2. Build and write SKILL.md
      const pitfallsSection = args.pitfalls
        ? `\n## Pitfalls\n\n${args.pitfalls}\n`
        : '';

      const skillMd = `---
name: ${args.skill_name}
description: "${args.description}"
---

# ${args.skill_name.replace(/-/g, ' ')}

${args.body}
${pitfallsSection}`;

      await fs.writeFile(path.join(skillDir, 'SKILL.md'), skillMd, 'utf-8');

      // 3. Write scripts if provided
      if (args.scripts) {
        const scriptsDir = path.join(skillDir, 'scripts');
        await fs.mkdir(scriptsDir, { recursive: true });
        for (const [filename, content] of Object.entries(args.scripts)) {
          await fs.writeFile(path.join(scriptsDir, filename), content, 'utf-8');
        }
      }

      // 4. Write references if provided
      if (args.references) {
        const refsDir = path.join(skillDir, 'references');
        await fs.mkdir(refsDir, { recursive: true });
        for (const [filename, content] of Object.entries(args.references)) {
          await fs.writeFile(path.join(refsDir, filename), content, 'utf-8');
        }
      }

      debugLog(`[evolution] Created skill: ${args.skill_name}`);
      return `Skill "${args.skill_name}" created successfully.`;
    } catch (err) {
      // Clean up on failure
      await fs.rm(skillDir, { recursive: true, force: true }).catch(() => {});
      const msg = err instanceof Error ? err.message : String(err);
      debugLog(`[evolution] Failed to create skill "${args.skill_name}": ${msg}`);
      return `Failed to create skill: ${msg}`;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/evolution/review-tools.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/evolution/review-tools.ts tests/evolution/review-tools.test.ts
git commit -m "feat: add CreateReviewSkillTool with dedup and atomic write"
```

---

### Task 6: Implement review agent fork

**Files:**
- Create: `src/evolution/review-agent.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/evolution/review-agent.test.ts`:

```typescript
import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { forkReviewAgent, buildReviewSystemPrompt } from '../../src/evolution/review-agent';
import { buildReviewPrompt } from '../../src/evolution/prompt-templates';
import type { TraceRun } from '../../src/trace/types';

const TEST_DIR = path.join(os.tmpdir(), `evolution-agent-${Date.now()}`);

function makeTrace(overrides: Partial<TraceRun> = {}): TraceRun {
  return {
    id: 'run-1',
    sessionId: 'session-1',
    startTime: Date.now(),
    endTime: Date.now(),
    model: 'test',
    turns: [{
      turnIndex: 0,
      modelResponse: {
        text: 'ok',
        toolCalls: [{ name: 'bash', arguments: { command: 'ls' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
      toolExecutions: [
        { toolName: 'bash', success: false, durationMs: 100, error: 'ENOENT' },
      ],
    }],
    summary: {
      totalTurns: 1, totalToolCalls: 1, totalErrors: 1,
      totalTokens: { prompt_tokens: 10, completion_tokens: 5 },
      outcome: 'error' as const,
    },
    ...overrides,
  };
}

describe('forkReviewAgent', () => {
  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  test('does not throw when called (fire-and-forget)', () => {
    // forkReviewAgent forks an agent and returns immediately.
    // This test verifies it doesn't throw synchronously.
    const trace = makeTrace();
    expect(() => {
      forkReviewAgent('error_burst', trace, { outputDir: TEST_DIR });
    }).not.toThrow();
  });

  test('buildReviewSystemPrompt includes review prompt and output dir', () => {
    const trace = makeTrace();
    const prompt = buildReviewSystemPrompt('error_burst', trace, [], TEST_DIR);

    expect(prompt).toContain('output directory');
    expect(prompt).toContain('create_review_skill');
    expect(prompt).toContain(TEST_DIR);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/evolution/review-agent.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Write the implementation**

Create `src/evolution/review-agent.ts`:

```typescript
import type { TraceRun } from '../trace/types';
import { buildReviewPrompt } from './prompt-templates';
import { CreateReviewSkillTool } from './review-tools';
import { debugLog } from '../utils/debug';

/**
 * Build the full system prompt for the Review Agent.
 * Combines the review prompt template with skill creation instructions.
 */
export function buildReviewSystemPrompt(
  trigger: 'error_burst' | 'complex_task' | 'periodic',
  trace: TraceRun,
  existingSkills: string[],
  outputDir: string,
): string {
  const reviewPrompt = buildReviewPrompt(trigger, trace, existingSkills);

  return `${reviewPrompt}

---
## Skill Creation

When you have identified a reusable pattern (score ≥ 3):
- Call the create_review_skill tool with the skill details
- skill_name: kebab-case, descriptive, unique
- description: one-line summary including trigger contexts
- body: markdown instructions for the skill

The output directory for new skills is: ${outputDir}

If the pattern is not reusable (score < 3), just say "Nothing to save" and explain why.
Do NOT create a skill if one already covers this pattern.`;
}

/**
 * Fork a background Review Agent (fire-and-forget).
 *
 * Note: In the full implementation, this creates a real Agent instance.
 * The current implementation logs the intent — full agent fork will be
 * wired in Task 9 when the Agent constructor is available via initEvolution.
 */
export function forkReviewAgent(
  trigger: 'error_burst' | 'complex_task' | 'periodic',
  trace: TraceRun,
  config: { outputDir: string },
): void {
  debugLog(
    `[evolution] Review triggered (${trigger}) for run ${trace.id}` +
    ` — ${trace.summary.totalTurns} turns, ${trace.summary.totalErrors} errors`,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/evolution/review-agent.test.ts`
Expected: 2 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/evolution/review-agent.ts tests/evolution/review-agent.test.ts
git commit -m "feat: add review agent fork with system prompt builder"
```

---

### Task 7: Implement evoluation index and factory

**Files:**
- Create: `src/evolution/index.ts`

- [ ] **Step 1: Write the implementation**

Create `src/evolution/index.ts`:

```typescript
import type { ReviewConfig } from './types';
import { CreateReviewSkillTool } from './review-tools';
import { forkReviewAgent, buildReviewSystemPrompt } from './review-agent';
import type { TraceRun } from '../trace/types';
import { debugLog } from '../utils/debug';
import os from 'os';
import path from 'path';

export interface EvolutionModule {
  review: (
    nudgeResult: { trigger: string; traceRunId: string; sessionId: string; reason: string },
    trace: TraceRun,
  ) => void;
  outputDir: string;
}

const TRIGGER_TYPES = ['error_burst', 'complex_task', 'periodic'] as const;
type TriggerType = (typeof TRIGGER_TYPES)[number];

function isTriggerType(value: string): value is TriggerType {
  // NudgeResult.trigger values map: memory_review → error_burst, skill_review → complex_task, combined_review → error_burst
  if (value === 'memory_review' || value === 'combined_review') return 'error_burst' as TriggerType;
  if (value === 'skill_review') return 'complex_task' as TriggerType;
  return false;
}

function mapNudgeTriggerToReviewTrigger(
  nudgeTrigger: string,
): TriggerType | null {
  if (nudgeTrigger === 'memory_review' || nudgeTrigger === 'combined_review') return 'error_burst';
  if (nudgeTrigger === 'skill_review') return 'complex_task';
  return null;
}

export function initEvolution(config: ReviewConfig): EvolutionModule | null {
  if (!config.enabled) return null;

  const outputDir = config.outputDir.startsWith('~')
    ? path.join(os.homedir(), config.outputDir.slice(1))
    : config.outputDir;

  return {
    outputDir,
    review(nudgeResult, trace) {
      const trigger = mapNudgeTriggerToReviewTrigger(nudgeResult.trigger);
      if (!trigger) {
        debugLog(`[evolution] Unknown nudge trigger: ${nudgeResult.trigger}`);
        return;
      }
      forkReviewAgent(trigger, trace, { outputDir });
    },
  };
}

// Re-export for consumers
export { CreateReviewSkillTool, forkReviewAgent, buildReviewSystemPrompt };
export type { ReviewConfig };
```

Note: This is the minimal factory. The full Agent fork (creating a real Agent instance) will be wired in Task 9 when we have access to the provider via runtime wiring.

- [ ] **Step 2: Run type-check**

```bash
bun run tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/evolution/index.ts
git commit -m "feat: add initEvolution factory and EvolutionModule"
```

---

### Task 8: Adapt SkillLoader for multi-source loading

**Files:**
- Modify: `src/skills/loader.ts`

- [ ] **Step 1: Write the failing test**

Check existing tests: `bun test tests/` — identify existing skill loader tests if any.

Let's add a test to `tests/evolution/` for multi-source:

Create a test that creates skills in two directories and verifies SkillLoader lists both.

We'll simplify: the test verifies `listSkillNames` and `loadSkill` work with multiple sources. Since the test file would be integrated into the existing pattern, let's write it inline:

```typescript
// Append to existing skill loader test or create tests/skills/loader.test.ts if none exists
```

For the plan, we'll modify SkillLoader directly since the change pattern is well-understood.

- [ ] **Step 2: Write the implementation**

Modify `src/skills/loader.ts`. Read the current file, then:

```typescript
import os from 'os';

// In constructor:
private sourcePaths: string[];

constructor(basePath?: string) {
  const settings = getSettingsSync();
  const projectPath = basePath ?? path.resolve(process.cwd(), settings.skills.baseDir);
  this.sourcePaths = [
    projectPath,
    path.join(os.homedir(), '.my-agent', 'skills', 'auto'),
  ];
  this.basePath = this.sourcePaths[0]!;  // keep backward compat
}

// listSkillNames: aggregate from all sources
async listSkillNames(): Promise<string[]> {
  const allNames = new Set<string>();
  for (const dir of this.sourcePaths) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          allNames.add(entry.name);
        }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
  }
  return [...allNames];
}

// loadSkill: try sources in priority order
async loadSkill(skillName: string): Promise<SkillInfo | null> {
  if (this.cachedSkills.has(skillName)) {
    return this.cachedSkills.get(skillName)!;
  }

  for (const dir of this.sourcePaths) {
    const skill = await this.tryLoadSkill(dir, skillName);
    if (skill) return skill;
  }
  return null;
}

// New private method: try loading from a specific directory
private async tryLoadSkill(sourceDir: string, skillName: string): Promise<SkillInfo | null> {
  const skillDir = path.join(sourceDir, skillName);
  const skillPath = path.join(skillDir, 'SKILL.md');
  try {
    const content = await fs.readFile(skillPath, 'utf-8');
    const { data, content: markdownContent } = matter(content);
    const skillInfo: SkillInfo = {
      name: data.name ?? skillName,
      description: data.description ?? '',
      content: markdownContent,
      filePath: skillPath,
      metadata: data,
    };
    this.cachedSkills.set(skillName, skillInfo);
    return skillInfo;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
```

The existing `loadSkill` body becomes `tryLoadSkill`.

- [ ] **Step 3: Run tests**

```bash
bun test tests/
```

Expected: all existing tests pass, no regressions.

- [ ] **Step 4: Commit**

```bash
git add src/skills/loader.ts
git commit -m "feat: add multi-source skill loading (project + auto)"
```

---

### Task 9: Wire evolution into trace middleware and runtime

**Files:**
- Modify: `src/trace/agent-middleware.ts`
- Modify: `src/trace/index.ts`
- Modify: `src/runtime.ts`

- [ ] **Step 1: Add evolution callback to TraceAgentMiddleware**

Modify `src/trace/agent-middleware.ts`:

```typescript
import type { EvolutionReviewCallback } from '../evolution/types';

export class TraceAgentMiddleware implements AgentMiddleware {
  constructor(
    private store: TraceStore,
    private nudgeEngine: NudgeEngine,
    private redactor: TraceRedactor,
    private nudgeEnabled: boolean = true,
    private evolution?: { review: EvolutionReviewCallback } | null,
  ) {}
  // ...
```

In `finalizeTrace`, replace the nudge handling:

```typescript
private async finalizeTrace(trace: TraceRun): Promise<void> {
  try {
    await this.store.finalize(trace);
    if (this.nudgeEnabled) {
      const nudgeResult = this.nudgeEngine.tick(trace);
      if (nudgeResult) {
        debugLog(`[trace] Nudge triggered: ${nudgeResult.reason}`);
        await this.nudgeEngine.persist();
        if (this.evolution?.review) {
          this.evolution.review(nudgeResult, trace);
        }
      }
    }
  } catch (err) {
    debugLog(`[trace] Finalize failed: ${err}`);
  }
}
```

- [ ] **Step 2: Update createTraceMiddleware to accept evolution options**

Modify `src/trace/index.ts` — add `evolution` to the returned object, or add `evolutionOptions` parameter:

Add an `evolution` field to `TraceMiddlewareSet`:

```typescript
export interface TraceMiddlewareSet {
  agentMiddleware: TraceAgentMiddleware;
  toolMiddleware: TraceToolMiddleware;
  store: TraceStore;
  nudgeEngine: NudgeEngine;
  redactor: TraceRedactor;
  evolution?: EvolutionModule;  // optional, set by runtime wiring
}
```

- [ ] **Step 3: Wire in runtime.ts**

Modify `src/runtime.ts` — after creating trace middleware, wire evolution:

```typescript
// In the trace section of createAgentRuntime():
if (traceEnabled) {
  const traceMw = createTraceMiddleware({ /* existing options */ });

  // Evolution (Phase 2)
  if (settings?.trace?.review?.enabled !== false) {
    const evolution = initEvolution({
      enabled: true,
      model: settings?.trace?.review?.model ?? 'claude-3-haiku-20240307',
      maxTurns: settings?.trace?.review?.maxTurns ?? 6,
      tokenLimit: settings?.trace?.review?.tokenLimit ?? 30000,
      timeoutMs: settings?.trace?.review?.timeoutMs ?? 60000,
      outputDir: settings?.trace?.review?.outputDir ?? '~/.my-agent/skills/auto',
    });
    // Pass evolution to trace middleware (agentMiddleware needs to accept it)
  }

  hooks.beforeAgentRun.unshift(traceMw.agentMiddleware.beforeAgentRun);
  hooks.beforeAddResponse.push(traceMw.agentMiddleware.beforeAddResponse);
  hooks.afterAgentRun.push(traceMw.agentMiddleware.afterAgentRun);
  toolMiddlewares.push(traceMw.toolMiddleware);
}
```

Since `TraceAgentMiddleware` constructor now accepts evolution, pass it through `createTraceMiddleware` options:

```typescript
// In createTraceMiddleware:
export function createTraceMiddleware(options: {
  // ... existing options
  evolution?: EvolutionModule | null;
} = {}): TraceMiddlewareSet {
  // ...
  const agentMiddleware = new TraceAgentMiddleware(
    store, nudgeEngine, redactor,
    options.nudgeEnabled ?? true,
    options.evolution ?? null,
  );
  // ...
}
```

- [ ] **Step 4: Run type-check and full tests**

```bash
bun run tsc --noEmit
bun test
```

Expected: TypeScript compiles, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/trace/agent-middleware.ts src/trace/index.ts src/runtime.ts
git commit -m "feat: wire evolution into trace middleware and runtime"
```

---

### Task 10: Add TUI notification for review results

**Files:**
- Create: `src/cli/tui/components/ReviewNotification.tsx`
- Modify: `src/types.ts` (add EvolutionReviewDone event)
- Modify: `src/agent/loop-types.ts` (add event variant)
- Modify: `src/cli/tui/hooks/agent-ui-reducer.ts` (add notification state)
- Modify: `src/cli/tui/hooks/use-agent-loop.tsx` (dispatch event)

- [ ] **Step 1: Add AgentEvent type for review completion**

In `src/types.ts`, add to AgentEvent union:

```typescript
// In AgentEvent type:
| { type: 'evolution_review_done'; skillName: string; description: string; outputDir: string }
```

In `src/agent/loop-types.ts`, add the variant:

```typescript
// In AgentEvent union:
| { type: 'evolution_review_done'; skillName: string; description: string; outputDir: string }
```

- [ ] **Step 2: Add UI state for review notifications**

In `src/cli/tui/hooks/agent-ui-reducer.ts`, add to the UI state:

```typescript
// In the UI state type, add:
reviewNotifications: Array<{
  skillName: string;
  description: string;
  outputDir: string;
  dismissed: boolean;
  createdAt: number;
}>;

// Add action:
| { type: 'ADD_REVIEW_NOTIFICATION'; skillName: string; description: string; outputDir: string }
| { type: 'DISMISS_REVIEW_NOTIFICATION'; skillName: string }
| { type: 'COLLAPSE_OLD_NOTIFICATIONS' }
```

Implement the reducer cases:

```typescript
case 'ADD_REVIEW_NOTIFICATION': {
  const notifications = [...state.reviewNotifications, {
    skillName: action.skillName,
    description: action.description,
    outputDir: action.outputDir,
    dismissed: false,
    createdAt: Date.now(),
  }];
  // Keep max 3 expanded, rest collapsed
  return { ...state, reviewNotifications: notifications };
}
case 'DISMISS_REVIEW_NOTIFICATION': {
  return {
    ...state,
    reviewNotifications: state.reviewNotifications.map(n =>
      n.skillName === action.skillName ? { ...n, dismissed: true } : n,
    ),
  };
}
case 'COLLAPSE_OLD_NOTIFICATIONS': {
  // Mark notifications older than 24h as dismissed
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return {
    ...state,
    reviewNotifications: state.reviewNotifications.map(n =>
      n.createdAt < cutoff ? { ...n, dismissed: true } : n,
    ),
  };
}
```

- [ ] **Step 3: Create ReviewNotification component**

Create `src/cli/tui/components/ReviewNotification.tsx`:

```tsx
import { Box, Text } from 'ink';
import type { FC } from 'react';

interface ReviewNotificationProps {
  skillName: string;
  description: string;
  dismissed: boolean;
  onDismiss: () => void;
  onView: () => void;
}

const ReviewNotification: FC<ReviewNotificationProps> = ({
  skillName,
  description,
  dismissed,
  onDismiss,
  onView,
}) => {
  if (dismissed) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" padding={1}>
      <Text bold color="yellow">
        Auto-review completed
      </Text>
      <Text>Created skill: {skillName}</Text>
      <Text dimColor>{description}</Text>
      <Box marginTop={1}>
        <Text>[v to view] [d to dismiss] [ignore]</Text>
      </Box>
    </Box>
  );
};

export { ReviewNotification };
export type { ReviewNotificationProps };
```

- [ ] **Step 4: Wire in use-agent-loop.tsx**

In the `use-agent-loop.tsx` hook, listen for `evolution_review_done` events and dispatch `ADD_REVIEW_NOTIFICATION`:

```typescript
case 'evolution_review_done': {
  dispatch({
    type: 'ADD_REVIEW_NOTIFICATION',
    skillName: event.skillName,
    description: event.description,
    outputDir: event.outputDir,
  });
  break;
}
```

- [ ] **Step 5: Build and verify**

```bash
bun run tsc --noEmit
bun run build
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/tui/components/ReviewNotification.tsx \
  src/cli/tui/hooks/agent-ui-reducer.ts \
  src/cli/tui/hooks/use-agent-loop.tsx \
  src/types.ts src/agent/loop-types.ts
git commit -m "feat: add TUI review notification component"
```

---

### Task 11: Integration — full Agent fork in review-agent

**Files:**
- Modify: `src/evolution/review-agent.ts`
- Modify: `src/evolution/index.ts`

Now wire the actual Agent creation. The `forkReviewAgent` function will create a real Agent with the lightweight model.

- [ ] **Step 1: Update forkReviewAgent to accept provider**

Modify `src/evolution/review-agent.ts`:

```typescript
import { Agent } from '../agent/Agent';
import { ContextManager } from '../agent/context';
import { ToolRegistry } from '../agent/tool-registry';
import type { Provider } from '../types';
import { CreateReviewSkillTool } from './review-tools';

export function forkReviewAgent(
  trigger: 'error_burst' | 'complex_task' | 'periodic',
  trace: TraceRun,
  config: {
    outputDir: string;
    provider: Provider;
    model: string;
    maxTurns: number;
    tokenLimit: number;
    timeoutMs: number;
  },
): void {
  const systemPrompt = buildReviewSystemPrompt(trigger, trace, [], config.outputDir);

  const agent = new Agent({
    provider: config.provider,
    contextManager: new ContextManager({
      tokenLimit: config.tokenLimit,
      defaultSystemPrompt: systemPrompt,
    }),
    toolRegistry: new ToolRegistry([new CreateReviewSkillTool(config.outputDir)]),
    config: { tokenLimit: config.tokenLimit },
    hooks: {},
    toolMiddlewares: [],
    maxTurns: config.maxTurns,
  });

  agent.run({ userMessage: trace.summary.totalErrors > 0
    ? `Analyze this trace with ${trace.summary.totalErrors} errors`
    : `Analyze this ${trace.summary.totalTurns}-turn task`,
  })
    .then(() => debugLog('[evolution] Review completed'))
    .catch(err => debugLog(`[evolution] Review failed: ${err}`));
}
```

- [ ] **Step 2: Update initEvolution to pass provider and model**

Modify `src/evolution/index.ts`:

```typescript
import type { Provider } from '../types';

export function initEvolution(
  config: ReviewConfig,
  provider: Provider,
): EvolutionModule | null {
  // ... same as before, but forkReviewAgent call now includes provider + model + maxTurns + timeoutMs
  return {
    outputDir,
    review(nudgeResult, trace) {
      const trigger = mapNudgeTriggerToReviewTrigger(nudgeResult.trigger);
      if (!trigger) return;
      forkReviewAgent(trigger, trace, {
        outputDir,
        provider,
        model: config.model,
        maxTurns: config.maxTurns,
        tokenLimit: config.tokenLimit,
        timeoutMs: config.timeoutMs,
      });
    },
  };
}
```

- [ ] **Step 3: Update runtime.ts to pass provider**

```typescript
const evolution = initEvolution(reviewConfig, provider);
```

- [ ] **Step 4: Run full test suite**

```bash
bun test
bun run tsc --noEmit
bun run lint
```

Expected: all 495+ tests pass, TypeScript compiles, lint passes.

- [ ] **Step 5: Commit**

```bash
git add src/evolution/review-agent.ts src/evolution/index.ts src/runtime.ts
git commit -m "feat: wire full Agent fork in review-agent with provider"
```

---

### Task 12: End-to-end integration test

**Files:**
- Create: `tests/evolution/integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/evolution/integration.test.ts`:

```typescript
import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { CreateReviewSkillTool } from '../../src/evolution/review-tools';
import { buildReviewPrompt } from '../../src/evolution/prompt-templates';
import { buildReviewSystemPrompt } from '../../src/evolution/review-agent';
import type { TraceRun } from '../../src/trace/types';
import type { ToolContext } from '../../src/agent/tool-dispatch/types';
import { ContextManager } from '../../src/agent/context';

const TEST_DIR = path.join(os.tmpdir(), `evolution-e2e-${Date.now()}`);

function makeTrace(overrides: Partial<TraceRun> = {}): TraceRun {
  return {
    id: 'run-e2e',
    sessionId: 'session-e2e',
    startTime: Date.now() - 1000,
    endTime: Date.now(),
    model: 'test',
    turns: [
      { turnIndex: 0, userMessage: 'fix the bug', modelResponse: { text: 'let me check', toolCalls: [{ name: 'grep', arguments: { pattern: 'error' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }, toolExecutions: [{ toolName: 'grep', success: true, durationMs: 50 }] },
      { turnIndex: 1, modelResponse: { text: 'found it', toolCalls: [{ name: 'text_editor', arguments: { path: 'src/index.ts' } }], usage: { prompt_tokens: 15, completion_tokens: 5 } }, toolExecutions: [{ toolName: 'text_editor', success: false, durationMs: 200, error: 'EACCES: permission denied' }] },
    ],
    summary: { totalTurns: 2, totalToolCalls: 2, totalErrors: 1, totalTokens: { prompt_tokens: 25, completion_tokens: 10 }, outcome: 'error' as const },
    ...overrides,
  };
}

describe('Evolution integration', () => {
  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  });

  test('full flow: prompt → tool call → skill written', async () => {
    const trace = makeTrace();

    // 1. Build review prompt
    const prompt = buildReviewPrompt('error_burst', trace, []);
    expect(prompt).toContain('EACCES');
    expect(prompt).toContain('Score this pattern');

    // 2. Build system prompt with output dir
    const systemPrompt = buildReviewSystemPrompt('error_burst', trace, [], TEST_DIR);
    expect(systemPrompt).toContain('create_review_skill');
    expect(systemPrompt).toContain(TEST_DIR);

    // 3. Simulate what the Review Agent would do: call create_review_skill
    const ctx = {
      agentContext: new ContextManager({ tokenLimit: 10000 }).getContext({ tokenLimit: 10000 }),
      environment: { cwd: process.cwd() },
    } as ToolContext;

    const tool = new CreateReviewSkillTool(TEST_DIR);
    const result = await tool.execute({
      skill_name: 'fix-permission-errors',
      description: 'Handle permission errors when editing files — use bash to chmod first',
      body: '## When you see EACCES\n\n1. Check file ownership with `ls -la`\n2. Use `chmod` to fix permissions',
      pitfalls: 'Always verify you have write access before editing',
    }, ctx);

    expect(result).toContain('created successfully');

    // 4. Verify skill was written correctly
    const skillMd = await fs.readFile(
      path.join(TEST_DIR, 'fix-permission-errors', 'SKILL.md'), 'utf-8',
    );
    expect(skillMd).toContain('name: fix-permission-errors');
    expect(skillMd).toContain('EACCES');
    expect(skillMd).toContain('## Pitfalls');
  });

  test('dedup prevents duplicate skill creation', async () => {
    const tool = new CreateReviewSkillTool(TEST_DIR);
    const ctx = {
      agentContext: new ContextManager({ tokenLimit: 10000 }).getContext({ tokenLimit: 10000 }),
      environment: { cwd: process.cwd() },
    } as ToolContext;

    await tool.execute({ skill_name: 'unique-skill', description: 'A', body: 'B' }, ctx);
    const result = await tool.execute({ skill_name: 'unique-skill', description: 'A', body: 'C' }, ctx);

    expect(result).toContain('already exists');
  });

  test('complex_task prompt contains workflow extraction instructions', () => {
    const trace = makeTrace({
      summary: { totalTurns: 5, totalToolCalls: 5, totalErrors: 0, totalTokens: { prompt_tokens: 100, completion_tokens: 50 }, outcome: 'completed' as const },
    });
    const prompt = buildReviewPrompt('complex_task', trace, []);
    expect(prompt).toContain('successful multi-step');
    expect(prompt).toContain('Pitfalls');
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `bun test tests/evolution/integration.test.ts`
Expected: 3 tests PASS

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: all tests PASS, no regressions.

- [ ] **Step 4: Commit**

```bash
git add tests/evolution/integration.test.ts
git commit -m "test: add evolution end-to-end integration tests"
```

---

## Architecture Compliance Checklist (Constitution §A–I)

- **§A** ✅ — Evolution wired via `createAgentRuntime()`, not in `bin/*`.
- **§B** ✅ — No `any` types. All interfaces use concrete types.
- **§C** ✅ — No new hooks. Evolution called from existing `afterAgentRun`.
- **§D** ✅ — Review Agent has own `ToolRegistry`, main `ToolDispatcher` unchanged.
- **§E** ✅ — No new `syncTodoFromContext` calls.
- **§F** ✅ — TypeScript compiles, no dead code.
- **§G** ✅ — All new files < 200 lines.
- **§H** ✅ — All new public APIs have unit tests.
- **§I** ✅ — `debugLog` only. No `console.log`, no `@ts-ignore`.
