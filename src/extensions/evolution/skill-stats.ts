import type { SkillStatsStore } from '../../application/ports/skill-stats-store'
import type { SkillStats } from '../../domain/skill-stats'

const SUCCESS_OUTCOMES = new Set(['accepted'])

export async function bumpStat(
  store: SkillStatsStore,
  skillName: string,
  outcome: 'accepted' | 'rejected' | 'inconclusive',
): Promise<void> {
  const cur = await store.get(skillName)
  const stats: SkillStats = cur ?? {
    name: skillName,
    totalRuns: 0,
    successfulRuns: 0,
    lastReviewedAt: 0,
  }
  stats.totalRuns++
  if (SUCCESS_OUTCOMES.has(outcome)) stats.successfulRuns++
  stats.lastReviewedAt = Date.now()
  await store.put(stats)
}
