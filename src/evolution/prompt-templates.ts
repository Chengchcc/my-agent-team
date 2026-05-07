import type { TraceRun } from '../trace/types';

// ---------------------------------------------------------------------------
// Template constants
// ---------------------------------------------------------------------------

const ERROR_BURST_PROMPT = `\
You are reviewing an agent session that experienced errors.

Trace Summary:
- Total turns: {totalTurns}
- Total errors: {totalErrors}
- Failed tools: {failedToolNames}

Full trace:
{trace}

Existing skills:
{existingSkills}

Review the agent's behavior above. Identify if there is a reusable pattern that should be saved as a new skill.

Scoring:
- Score this pattern 1\u20135 based on recurrence likelihood and generalization potential.
- If the score is less than 3, respond with "Nothing to save" and explain why.

Existing skills to consider (do NOT duplicate):
{existingSkills}`;

const COMPLEX_TASK_PROMPT = `\
You are reviewing a successful multi-step agent session.

Trace Summary:
- Total turns: {totalTurns}
- Tools used: {toolNames}

Full trace:
{trace}

Existing skills:
{existingSkills}

Review the successful multi-step workflow above and determine if it should be saved as a new skill.

Scoring:
- Score this workflow 1\u20135 based on reusability.

Existing skills to consider (do NOT duplicate):
{existingSkills}`;

const PERIODIC_PROMPT = `\
Periodic review of recent agent sessions.

Review interval: every {reviewInterval} turns.

Recent trace summaries:
{recentTraceSummaries}

Existing skills:
{existingSkills}

Review the recent sessions above and identify patterns that could be captured as new skills.

If no valuable patterns emerge, respond with "Nothing to save".

Existing skills to consider (do NOT duplicate):
{existingSkills}`;

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
