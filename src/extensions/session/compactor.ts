import type { Compactor } from '../../application/usecases/compact-session'
import type { ProviderInvoke } from '../../application/ports/provider'
import { COMPACT_MAX_OUTPUT_TOKENS, COMPACT_SUMMARY_PROMPT } from '../../application/constants/compact'

export function createCompactor(deps: { invoke: ProviderInvoke }): Compactor {
  return {
    async summarize({ sessionId, messages }) {
      const transcript = messages.map(m => {
        const content = typeof m.content === 'string'
          ? m.content
          : m.blocks ? JSON.stringify(m.blocks) : ''
        return `[${m.role}] ${content}`
      }).join('\n\n')

      const res = await deps.invoke.call({
        kind: 'internal',
        purpose: 'session.compact',
        parentTurnId: `compact:${sessionId}`,
        messages: [
          { role: 'system', content: COMPACT_SUMMARY_PROMPT },
          { role: 'user', content: transcript },
        ],
        maxTokens: COMPACT_MAX_OUTPUT_TOKENS,
      })
      return { summary: res.content, usage: res.usage }
    },
  }
}
