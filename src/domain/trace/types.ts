// Trace domain types — shared across extensions and ports.
// Promoted from extensions/trace/trace/types.ts (P-6).

export interface TraceTurn {
  turnIndex: number
  userMessage?: string
  modelResponse?: {
    thinking?: string
    text: string
    toolCalls: Array<{
      name: string
      arguments: Record<string, unknown>
    }>
    usage: Record<string, number>
  }
  toolExecutions: Array<{
    toolName: string
    success: boolean
    durationMs: number
    error?: string
  }>
  compaction?: {
    level: string
    beforeTokens: number
    afterTokens: number
  }
}

export interface TraceSummary {
  totalTurns: number
  totalToolCalls: number
  totalErrors: number
  totalTokens: Record<string, number>
  outcome: 'completed' | 'error' | 'max_turns' | 'aborted' | 'aborted_by_review' | 'compacted_mid' | 'cleared' | 'network_error'
  error?: string
  activatedSkills?: string[]
}

export interface TraceRun {
  id: string
  sessionId: string
  parentRunId?: string | undefined
  startTime: number
  endTime: number
  model: string
  turns: TraceTurn[]
  summary: TraceSummary
}
