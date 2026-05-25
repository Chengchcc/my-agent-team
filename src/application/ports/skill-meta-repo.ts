import type { SkillMeta } from '../../domain/skill-meta'

export interface SkillMetaRepo {
  get(skillName: string): Promise<SkillMeta | null>
  getAll(): Promise<SkillMeta[]>
  markFlagged(skillName: string, reason: string): Promise<void>
  markArchived(skillName: string, at: number): Promise<void>
  reset(skillName: string): Promise<void>
}
