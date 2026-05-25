/** Persisted metadata for a skill used by the auto-retire system. */
export interface SkillMeta {
  skillName: string
  flagged: boolean
  flaggedAt?: number
  flaggedReason?: string
  archivedAt?: number
}
