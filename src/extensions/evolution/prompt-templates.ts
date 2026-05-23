import type { ReviewJob } from './types'

const TURN_PREVIEW_CHARS = 300
const TIER0_MAX_TOKENS = 2000
const TIER2_MAX_TOKENS = 3000

interface PromptResult {
  messages: Array<{ role: 'system' | 'user'; content: string }>
  maxTokens: number
}

export function buildPrompt(job: ReviewJob): PromptResult {
  return job.tier === 'tier0' ? buildTier0(job) : buildTier2(job)
}

function formatRun(job: ReviewJob): string {
  const run = job.run
  const lines: string[] = [
    `Run ID: ${run.id}`,
    `Session: ${run.sessionId}`,
    `Model: ${run.model}`,
    `Duration: ${run.endTime - run.startTime}ms`,
    `Turns: ${run.summary.totalTurns}`,
    `Tool calls: ${run.summary.totalToolCalls}`,
    `Errors: ${run.summary.totalErrors}`,
    `Outcome: ${run.summary.outcome}`,
  ]
  for (let i = 0; i < run.turns.length; i++) {
    const turn = run.turns[i]!
    lines.push(`--- Turn ${turn.turnIndex} ---`)
    if (turn.userMessage) lines.push(`User: ${turn.userMessage.slice(0, TURN_PREVIEW_CHARS)}`)
    if (turn.modelResponse) {
      lines.push(`Response: ${turn.modelResponse.text.slice(0, TURN_PREVIEW_CHARS)}`)
      const tools = turn.modelResponse.toolCalls.map(tc => tc.name).join(', ')
      if (tools) lines.push(`Tool calls: ${tools}`)
    }
    for (const exec of turn.toolExecutions) {
      lines.push(`  ${exec.toolName}: ${exec.success ? 'ok' : 'FAIL'} ${exec.error ? `(${exec.error.slice(0, 100)})` : ''}`)
    }
  }
  return lines.join('\n')
}

function buildTier0(job: ReviewJob): PromptResult {
  const systemPrompt = `You are a code-quality reviewer analyzing completed agent sessions. Your task is to determine whether the agent's workflow contains reusable patterns worth capturing as a skill.

## Why this matters

When an agent hits the same class of error repeatedly or executes a multi-step workflow that took trial-and-error to get right, encoding the pattern as a skill saves future sessions from reinventing a fix. A good skill explains not just what to do but WHY the pattern works and how to recognize the situation early.

## Review methodology

1. Understand what happened: Was this a success or a failure? What tools were used? Did the agent struggle or execute smoothly?
2. Score reusability on a 1-5 scale:
   Score 1-2 (don't save): One-off typos, project-specific fixes, trivial corrections the agent self-corrected immediately.
   Score 3 (borderline): Narrow but non-obvious pattern. Save only if the task took 5+ turns.
   Score 4-5 (save): Multi-turn recovery workflow, non-obvious decisions a naive agent would miss, or a class of problems that recurs across projects.
3. Look for investigation-action-verification rhythms that would guide future agents.

## Pitfalls to avoid
- Overfitting to exact file paths or command arguments from this session
- Creating a recipe without reasoning — explain WHY each step matters
- Duplicating the conceptual purpose of existing skills
- Error-only focus: teach recovery AND prevention, include detection signals

## Response format

Return JSON:
{
  "outcome": "accepted" | "rejected" | "inconclusive",
  "reasoning": "Brief explanation of your decision and reusability score",
  "skillProposed": {
    "name": "short-kebab-name",
    "description": "One-line summary of what this skill does",
    "trigger": "When should this skill be activated? Include near-miss phrasings",
    "instructions": "The skill body: what to investigate, what actions to take, how to verify"
  }
}

Include skillProposed ONLY if outcome is "accepted".`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: formatRun(job) },
    ],
    maxTokens: TIER0_MAX_TOKENS,
  }
}

function buildTier2(job: ReviewJob): PromptResult {
  const systemPrompt = `You are a skill design reviewer. Your task is to evaluate a specific skill's effectiveness based on its usage statistics and recent trace data, then recommend whether to keep, fix, or retire the skill.

## Why this matters

Skills accumulate over time, and not all of them remain useful. A skill that consistently leads to errors, is rarely used, or has been superseded by better approaches wastes the agent's attention and token budget. Regular skill review keeps the skill library lean and effective.

## Review methodology

1. Examine the skill's usage statistics: total runs, success rate, and when it was last reviewed.
2. Look at recent traces where this skill was activated — did it help or hinder?
3. Consider:
   - Success rate < 50% and > 5 runs → skill likely needs fixing or retiring
   - Success rate 50-80% → skill may need adjustments to instructions or trigger
   - Success rate > 80% → skill is effective, keep as-is
   - Very low usage (< 3 runs in a long period) → consider if the trigger is too narrow
   - Skill producing errors in a common pattern → fix the instructions to warn about the pitfall
4. Decide: keep, fix (adjust instructions), or delete.

## Response format

Return JSON:
{
  "outcome": "accepted" | "rejected" | "inconclusive",
  "reasoning": "Brief explanation of your verdict based on stats and trace patterns",
  "skillProposed": {
    "name": "same-or-new-skill-name",
    "description": "Updated description if fixing",
    "trigger": "Updated trigger description",
    "instructions": "Updated instructions with learnings incorporated"
  }
}

Set outcome "accepted" to keep the skill, "rejected" to recommend deletion, "inconclusive" if more data is needed.
Include skillProposed with UPDATED fields only when suggesting a fix (outcome "accepted" with modifications).`

  const statsText = job.stats
    ? `Stats for "${job.skillName ?? 'unknown'}": ${job.stats.totalRuns} runs, ${job.stats.successfulRuns} successful, last reviewed ${new Date(job.stats.lastReviewedAt).toISOString()}`
    : `No accumulated stats for "${job.skillName ?? 'unknown'}"`

  return {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `${statsText}\n\nTrace:\n${formatRun(job)}` },
    ],
    maxTokens: TIER2_MAX_TOKENS,
  }
}
