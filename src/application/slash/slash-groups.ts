import type { SlashGroup } from './slash-types'

export const SLASH_GROUPS: SlashGroup[] = [
  { name: 'core', description: 'Essential commands', commands: [] },
  { name: 'session', description: 'Session management', commands: [] },
  { name: 'context', description: 'Context window management', commands: [] },
  { name: 'tooling', description: 'Tool and capability inspection', commands: [] },
  { name: 'ui', description: 'Interface controls', commands: [] },
  { name: 'workflow', description: 'Workflow and skill commands', commands: [] },
  { name: 'debug', description: 'Diagnostics and debugging', commands: [] },
  { name: 'admin', description: 'Administrative commands', commands: [] },
]
