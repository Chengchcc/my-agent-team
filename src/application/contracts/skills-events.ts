export interface SkillsReloadRequestedV1 {
  reason: 'evolution.promote' | 'manual' | 'config-change'
  source?: string
}
