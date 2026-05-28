export type BootstrapMode = 'full' | 'limited' | 'none'

export interface BootstrapModeInput {
  identityStatus: 'pending_bootstrap' | 'active' | 'degraded'
  hasToolAccess: boolean
  isHeadless: boolean
}

export function resolveBootstrapMode(input: BootstrapModeInput): BootstrapMode {
  if (input.identityStatus !== 'pending_bootstrap') return 'none'
  if (input.isHeadless) return 'limited'
  return 'full'
}
