import type { SkillMeta } from '../../domain/skill-meta'

export interface SkillMetaRepo {
  get(skillName: string): Promise<SkillMeta | null>
  getAll(): Promise<SkillMeta[]>
  markArchived(skillName: string, at: number): Promise<void>
}
