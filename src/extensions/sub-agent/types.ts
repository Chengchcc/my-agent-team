export interface SubAgentDescriptor {
  type: string
  description: string
  systemPrompt: string
  allowedToolNames: readonly string[]
  maxRounds?: number
  maxOutputTokens?: number
  modelHint?: 'fast' | 'strong'
  source: 'builtin' | 'extension'
}

export interface SubAgentRunInput {
  type: string
  prompt: string
  parentSessionId: string
  parentTurnId: string
  parentCallId: string
  parentSignal: AbortSignal
}

export type SubAgentRunner = (input: SubAgentRunInput) => Promise<string>
