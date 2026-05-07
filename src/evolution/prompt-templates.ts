import type { TraceRun } from '../trace/types';

// ---------------------------------------------------------------------------
// Template constants
// ---------------------------------------------------------------------------

const ERROR_BURST_PROMPT = `\
You are reviewing an agent session that experienced errors. Your task is to determine
whether the failure pattern represents a reusable recovery workflow worth capturing
as a skill.

## Why this matters

When an agent hits the same class of error repeatedly, encoding the recovery pattern
as a skill saves future sessions from reinventing a fix. A good error-recovery skill
explains not just what to do but WHY the error occurs and how to recognize it early.

## Trace Summary
- Total turns: {totalTurns}
- Total errors: {totalErrors}
- Failed tools: {failedToolNames}

## Full trace
{trace}

## Existing skills (do NOT duplicate)
{existingSkills}

## Methodology

Follow these steps:

### 1. Understand the failure pattern
- Which tool(s) failed? Is it always the same tool or a category of tools?
- What was the root cause? (permissions, missing files, incorrect arguments, environment)
- Did the agent eventually recover? If so, how? If not, why not?
- Look at the sequence of turns: was there a "eureka" moment where the agent pivoted?

### 2. Score reusability (1-5)
Rate how likely this pattern is to help future sessions:

**Score 1-2 (don't save):**
- One-off typos or syntax mistakes the agent self-corrected immediately
- Errors caused by a unique project configuration unlikely to recur
- The "fix" is trivial (e.g., "use the right flag") and offers no decision-making guidance
- Example: agent typed \`npm instal\` instead of \`npm install\` and fixed it next turn

**Score 3 (borderline):**
- Pattern occurs in a somewhat common context but is narrow in scope
- The recovery involves a specific workaround, not a generalizable approach

**Score 4-5 (save):**
- A multi-turn recovery workflow that the agent figured out through trial and error
- The error class is common across projects (auth, permissions, missing tools, API limits)
- The fix involves a decision tree: "try X first, if that fails do Y, fall back to Z"
- The agent wasted 2+ turns learning something a skill could have taught immediately
- Example: a 4-turn saga of installing missing system dependencies, discovering
  version conflicts, and settling on a containerized workaround — this is gold for
  anyone hitting the same dependency hell

### 3. Decide
- Score < 3: respond with "Nothing to save" and a brief explanation of why the
  pattern is too narrow or trivial
- Score >= 3: design the skill (see Skill Creation section)

## Good vs bad skills from error traces

**Good skill** (from a real trace):
> The agent's \`grep\` calls kept failing because it assumed GNU grep flags
> (\`-P\` for Perl regex) on macOS which uses BSD grep. After 3 turns of
> confusion, it learned to detect the OS and switch flag sets.
> Skill: "portable-grep — detect OS and use compatible grep flags"

**Bad skill** (don't create this):
> The agent passed an extra argument to a project-specific script and got
> an error. It corrected the argument next turn.
> Skill: "use-correct-args-for-my-script" — this is memorizing a one-off
> API, not a reusable pattern.

## Pitfalls to avoid

- **Overfitting to the trace**: Don't create a skill that only works for the
  exact file paths or command arguments in this session. Generalize.
- **Recipe without reasoning**: A skill that says "run these 3 commands" without
  explaining WHY each is needed will fail when the situation differs slightly.
- **Duplicating existing skills**: If an existing skill already covers this
  pattern (e.g., "fix-permissions" covers permission errors), do NOT create
  another. Check {existingSkills} carefully.
- **Error-only focus**: The skill should teach recovery and prevention, not
  just document the error message. Include detection signals so future agents
  recognize the situation BEFORE wasting turns.`;

const COMPLEX_TASK_PROMPT = `\
You are reviewing a successful multi-step agent session. Your task is to determine
whether the workflow is reusable enough to capture as a skill.

## Why this matters

Multi-turn successes encode battle-tested workflows. When an agent figures out
a reliable sequence of steps — investigation, action, verification — capturing
that as a skill lets future agents (and users) execute it in fewer turns with
fewer mistakes. The best skills don't just list steps; they teach the mental model
so the agent can adapt when the situation differs.

## Trace Summary
- Total turns: {totalTurns}
- Tools used: {toolNames}

## Full trace
{trace}

## Existing skills (do NOT duplicate)
{existingSkills}

## Methodology

### 1. Extract the workflow phases

Good complex tasks have a natural rhythm. Identify these phases in the trace:

- **Investigation phase**: How did the agent explore and understand the problem?
  What did it read, search for, or inspect? Look for \`glob\`, \`grep\`, \`read\`,
  \`ls\` calls that built understanding.
- **Action phase**: What did the agent actually do? Which tools executed the core
  work? Look for \`bash\`, \`text-editor\`, \`write\` calls that produced output.
- **Verification phase**: How did the agent confirm success? Did it run tests,
  check outputs, validate against expectations?

Knowing these phases helps you write a skill that guides future agents through
the same rhythm rather than just listing every tool call.

### 2. Score reusability (1-5)

**Score 1-2 (don't save):**
- The workflow is specific to a single file, project, or one-time task
- Every step depends on exact paths, names, or values from this session
- No other user would ever ask for this exact thing
- Example: "rename variable X to Y in file Z" — purely mechanical, no
  reusable decision-making

**Score 3 (borderline):**
- Some steps are generalizable but the workflow is narrow (e.g., a specific
  framework convention that only some projects use)
- Save only if the task took 5+ turns (indicating the agent struggled to
  figure it out)

**Score 4-5 (save):**
- The workflow applies to a class of problems, not just this instance
- The agent made non-obvious decisions that a naive agent would miss
- The workflow balances multiple concerns (correctness, security, performance)
- The agent would have been faster with a skill guiding it
- Example: migrating a codebase from one library to another, handling
  imports, API changes, and test updates in a specific order

### 3. Design the skill (if score >= 3)

When you decide to create a skill, think about:

**Trigger description**: What would a user say that means "use this skill"?
  Be specific about contexts, not just "when doing X." Include near-miss
  phrasings that should also trigger it.

**Phases in the skill body**:
  - Start with investigation: what to look for, how to assess scope
  - Then action: the steps, in order, with WHY each matters
  - End with verification: how to confirm the result is correct

**Workarounds and pitfalls**: What goes wrong? What false paths did the agent
  take in this trace? Warn future agents away from them.

**Edge cases**: What happens when the situation differs? If the trace shows a
  workflow for a monorepo with pnpm, note that the pattern changes for npm or
  single-package repos.

## Skill design anti-patterns

- **Step-by-step without context**: "Step 1: run X. Step 2: run Y." — this
  breaks the moment anything differs from the trace. Explain WHY each step.
- **Too narrow**: The skill only handles the exact scenario from this trace.
  If you can't imagine at least 3 different situations where it would help,
  it's probably too narrow.
- **Too broad**: The skill tries to cover every possible variation and becomes
  a general reference manual. A skill should be focused enough to trigger
  reliably for a specific class of problems.`;

const PERIODIC_PROMPT = `\
Periodic review of recent agent sessions. Your job is to spot cross-run patterns
that may justify a new skill.

Review interval: every {reviewInterval} turns.

## Why this matters

Individual sessions rarely reveal patterns. But across many sessions, recurring
difficulties become visible — the same tool failures, the same multi-turn
workarounds, the same missing knowledge. Catching these patterns is how the
system self-improves over time rather than repeating the same mistakes forever.

## Recent trace summaries
{recentTraceSummaries}

## Existing skills (do NOT duplicate)
{existingSkills}

## How to analyze cross-run patterns

### 1. Look for recurring themes

Scan the summaries for patterns that repeat across sessions:

- **Same tool failing across different sessions**: If \`bash\` permission errors
  appear in 3+ summaries, there may be a missing setup step a skill could document.
- **Same multi-turn recovery pattern**: Did multiple sessions independently
  rediscover the same workaround? That workaround should be a skill.
- **Same knowledge gap**: Are agents repeatedly researching the same thing
  (e.g., "how do I set up a Python virtual environment" across different sessions)?
  A skill could pre-load that knowledge.
- **Escalation patterns**: Do sessions start with the same simple approach, fail,
  and then converge on the same correct approach? The correct approach is a skill.

### 2. Avoid false patterns

- Sessions that look similar but differ in root cause (e.g., two sessions both
  used \`bash\` but one failed due to permissions, the other due to missing binary)
- Coincidental overlap (e.g., two sessions happened to edit \`package.json\` —
  that's not a pattern, it's just a common file)
- Sessions that are naturally similar because they're part of the same project
  (not a generalizable pattern)

### 3. Decide

If you identify a strong cross-run pattern (score >= 3 on the reusability scale),
design a skill. If no valuable patterns emerge, respond with "Nothing to save"
and briefly explain which summaries you reviewed and why nothing stood out.

## Reusability scale reminder

- **1-2**: Too narrow, specific to one session, or trivial
- **3**: Borderline — save only if the pattern is strong and the workflow is
  non-obvious
- **4-5**: Clearly reusable, applies to a class of problems, would save future
  agents significant turns`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTraceForPrompt(trace: TraceRun): string {
  return JSON.stringify(trace.turns, null, 2);
}

function getFailedToolNames(trace: TraceRun): string {
  const failed = new Set<string>();
  for (const turn of trace.turns) {
    for (const exec of turn.toolExecutions) {
      if (!exec.success) {
        failed.add(exec.toolName);
      }
    }
  }
  return failed.size > 0 ? Array.from(failed).join(', ') : 'none';
}

function getToolNames(trace: TraceRun): string {
  const names = new Set<string>();
  for (const turn of trace.turns) {
    for (const exec of turn.toolExecutions) {
      names.add(exec.toolName);
    }
  }
  return names.size > 0 ? Array.from(names).join(', ') : 'none';
}

function formatExistingSkills(skills: string[]): string {
  if (skills.length === 0) return '(none)';
  return skills.map((s) => `- ${s}`).join('\n');
}

function getTemplate(trigger: 'error_burst' | 'complex_task' | 'periodic'): string {
  switch (trigger) {
    case 'error_burst':
      return ERROR_BURST_PROMPT;
    case 'complex_task':
      return COMPLEX_TASK_PROMPT;
    case 'periodic':
      return PERIODIC_PROMPT;
    default: {
      const exhaustive: never = trigger;
      throw new Error(`Unknown review trigger: ${exhaustive}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildReviewPrompt(
  trigger: 'error_burst' | 'complex_task' | 'periodic',
  trace: TraceRun,
  existingSkills: string[],
  reviewInterval?: number,
  recentTraceSummaries?: string[],
): string {
  const template = getTemplate(trigger);

  const replacements: Record<string, string> = {
    '{totalTurns}': String(trace.summary.totalTurns),
    '{totalErrors}': String(trace.summary.totalErrors),
    '{failedToolNames}': getFailedToolNames(trace),
    '{toolNames}': getToolNames(trace),
    '{trace}': formatTraceForPrompt(trace),
    '{existingSkills}': formatExistingSkills(existingSkills),
    '{reviewInterval}': reviewInterval !== undefined ? String(reviewInterval) : '',
    '{recentTraceSummaries}': recentTraceSummaries !== undefined ? (recentTraceSummaries.length > 0 ? recentTraceSummaries.join('\n') : '(none)') : '(none)',
  };

  let prompt = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    prompt = prompt.replaceAll(placeholder, value);
  }

  return prompt;
}
