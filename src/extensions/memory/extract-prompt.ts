import type { ExtractJob } from './types'

export function buildExtractPrompt(_job: ExtractJob): {
  messages: Array<{ role: 'system' | 'user'; content: string }>
  maxTokens: number
} {
  return {
    messages: [
      {
        role: 'system' as const,
        content: `Extract durable knowledge from the conversation. Output one candidate per paragraph with #tag prefixes.

Example:
#preference #tools
User prefers bash over zsh for scripting tasks.`,
      },
      {
        role: 'user' as const,
        content: 'Extract knowledge from the traced conversation.',
      },
    ],
    maxTokens: 800,
  }
}
