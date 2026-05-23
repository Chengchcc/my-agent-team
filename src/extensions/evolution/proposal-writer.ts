import type { ProposalStore } from '../../application/ports/proposal-store'
import type { ReviewResult } from './types'

export async function writeProposal(
  store: ProposalStore,
  result: ReviewResult,
  runId: string,
): Promise<void> {
  await store.append({
    id: result.proposalId,
    skillName: result.skillName,
    tier: result.tier,
    outcome: result.outcome,
    reasoning: result.reasoning,
    skillProposed: result.skillProposed,
    createdAt: Date.now(),
    runId,
  })
}
