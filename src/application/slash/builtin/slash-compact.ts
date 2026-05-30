import type { SlashCommand } from '../slash-types'

export const slashCompactCommand: SlashCommand = {
  name: 'compact',
  description: 'Compact the context window by summarizing history',
  source: 'builtin',
  group: 'context',
  async resolve(_input, ctx) {
    const r = await ctx.kernel.rpc('session.compact', { sessionId: ctx.sessionId }) as {
      ok: boolean; removedCount: number; reason?: string
      usage?: { input: number; output: number }
    }
    if (!r.ok) {
      return { kind: 'handled', message: `Compact failed: ${r.reason ?? 'unknown'}` }
    }
    if (r.removedCount === 0) {
      return { kind: 'handled', message: 'History below threshold — nothing to compact.' }
    }
    ctx.ui?.appendDivider?.('compact')
    const tokens = r.usage ? ` (used ${r.usage.input}+${r.usage.output} tokens)` : ''
    return {
      kind: 'handled',
      message: `Compacted ${r.removedCount} prior messages into a summary${tokens}.`,
    }
  },
}
