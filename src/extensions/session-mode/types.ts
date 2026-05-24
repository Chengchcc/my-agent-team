import type { ToolDescriptor } from '../../domain/turn-runner.types'

export interface ModeDescriptor {
  name: string
  description: string
  systemPromptAppend: string
  toolFilter: (tool: ToolDescriptor) => boolean
  source: 'builtin' | 'extension'
}
