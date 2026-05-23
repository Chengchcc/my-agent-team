import type { ReviewJob, ReviewResult } from './types'

const LLM_REASONING_PREVIEW_CHARS = 500

export function parseVerdict(llmOutput: string, job: ReviewJob): ReviewResult {
  const proposalId = crypto.randomUUID()
  try {
    const jsonMatch = llmOutput.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return { proposalId, tier: job.tier, outcome: 'inconclusive', reasoning: 'No JSON found in output' }
    }
    const parsed = JSON.parse(jsonMatch[0])
    return {
      proposalId,
      tier: job.tier,
      outcome: parsed.outcome ?? 'inconclusive',
      skillName: job.skillName,
      skillProposed: parsed.skillProposed,
      reasoning: parsed.reasoning ?? llmOutput.slice(0, LLM_REASONING_PREVIEW_CHARS),
    }
  } catch {
    return {
      proposalId,
      tier: job.tier,
      outcome: 'inconclusive',
      skillName: job.skillName,
      reasoning: llmOutput.slice(0, LLM_REASONING_PREVIEW_CHARS),
    }
  }
}
