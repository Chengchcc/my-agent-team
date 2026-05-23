import type { SkillStats } from '../../domain/skill-stats'

export interface SkillStatsStore {
  get(name: string): Promise<SkillStats | null>
  put(stats: SkillStats): Promise<void>
  list(): Promise<SkillStats[]>
}
