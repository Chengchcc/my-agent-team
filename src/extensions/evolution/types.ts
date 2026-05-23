import type { TraceRun } from '../../domain/trace/types'
import type { SkillStats } from '../../domain/skill-stats'

export type Tier = 'tier0' | 'tier2'

export interface ReviewJob {
  tier: Tier
  runId: string
  skillName?: string
  run: TraceRun
  stats: SkillStats | null
}

export interface ReviewResult {
  proposalId: string
  tier: Tier
  outcome: 'accepted' | 'rejected' | 'inconclusive'
  skillName?: string
  skillProposed?: {
    name: string
    description: string
    trigger: string
    instructions: string
  }
  reasoning: string
}
