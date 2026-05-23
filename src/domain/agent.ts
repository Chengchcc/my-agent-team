// Legacy Agent types — migrated from extensions/skills/internal/agent-legacy.ts.
// TODO: eliminate these types when the old Agent abstraction is fully removed.
// Used by: examples/basic.ts, tests/fixtures/fake-provider.ts

import type { ToolCall } from '../application/ports/provider-adapter'

/** Legacy type — inline since Message removed from provider-adapter. */
type Message = {
  id?: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  _ephemeral?: boolean
  name?: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export type AgentConfig = {
  tokenLimit: number
  defaultSystemPrompt?: string
  model?: string
  cwd?: string
}

export type AgentContext = {
  messages: Message[]
  config: AgentConfig
  metadata: Record<string, unknown>
  response?: {
    content: string
    blocks?: unknown[]
    tool_calls?: ToolCall[]
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
    model: string
  }
  systemPrompt?: string
  ephemeralReminders?: string[]
}
