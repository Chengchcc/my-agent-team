/** A review verdict persisted by evolution ext. */
export interface ProposalRecord {
  id: string
  skillName?: string
  tier: 'tier0' | 'tier2'
  outcome: 'accepted' | 'rejected' | 'inconclusive'
  reasoning: string
  skillProposed?: {
    name: string
    description: string
    trigger: string
    instructions: string
  }
  createdAt: number  // unix ms
  runId: string
}
