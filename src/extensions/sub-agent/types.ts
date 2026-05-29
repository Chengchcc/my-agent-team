export interface SubAgentDescriptor {
  type: string
  description: string
  systemPrompt: string
  allowedToolNames: readonly string[]
  maxRounds?: number
  maxTokensPerCall?: number   // renamed from maxOutputTokens — per-call max_tokens
  maxTotalTokens?: number      // cross-round budget cap (melt protection)
  lifetimeMs?: number          // total timeout (default 120s)
  modelHint?: 'fast' | 'strong'
  source: 'builtin' | 'extension'
}

export interface SubAgentRunInput {
  type: string
  prompt: string
  description: string
  parentSessionId: string
  parentTurnId: string
  parentCallId: string
  parentSignal: AbortSignal
}

export type SubAgentRunner = (input: SubAgentRunInput) => Promise<string>
