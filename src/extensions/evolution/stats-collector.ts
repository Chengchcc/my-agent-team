import type { SkillStats } from '../../domain/skill-stats'

export interface SkillStatsSnapshot {
  skillName: string
  totalRuns: number
  recentRuns: number
  recentSuccess: number
  recentCancel: number
  recentFail: number
  flagged: boolean
  flaggedAt?: number
}

type Outcome = 'success' | 'cancel' | 'fail'

interface RecentEntry {
  outcome: Outcome
  at: number
}

/**
 * In-memory sliding-window stats collector per skill.
 * Window is not persisted across restarts (MVP simplification).
 */
export class StatsCollector {
  private recent = new Map<string, RecentEntry[]>()

  constructor(private windowSize: number = 20) {}

  record(skillName: string, outcome: Outcome): void {
    const arr = this.recent.get(skillName) ?? []
    arr.push({ outcome, at: Date.now() })
    if (arr.length > this.windowSize) {
      arr.shift()
    }
    this.recent.set(skillName, arr)
  }

  snapshot(
    skillName: string,
    stats: SkillStats | null,
    flagged: boolean = false,
    flaggedAt?: number,
  ): SkillStatsSnapshot {
    const recent = this.recent.get(skillName) ?? []
    return {
      skillName,
      totalRuns: stats?.totalRuns ?? 0,
      recentRuns: recent.length,
      recentSuccess: recent.filter(e => e.outcome === 'success').length,
      recentCancel: recent.filter(e => e.outcome === 'cancel').length,
      recentFail: recent.filter(e => e.outcome === 'fail').length,
      flagged,
      flaggedAt,
    }
  }
}
