export interface SkillsReloadRequestedV1 {
  reason: 'evolution.promote' | 'manual' | 'config-change' | 'auto-retire'
  source?: string
}
