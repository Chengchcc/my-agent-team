import type { SlashCommand } from '../slash-types'

export const slashCostCommand: SlashCommand = {
  name: 'cost',
  description: 'Show token usage statistics for the current session',
  source: 'builtin',
  group: 'debug',
  async resolve(_input, ctx) {
    const stats = await ctx.kernel.rpc('session.stats', { sessionId: ctx.sessionId }) as {
      usage: { input: number; output: number }; turnCount: number
    }
    return {
      kind: 'handled',
      message: `Tokens: ${stats.usage.input.toLocaleString()} input, ${stats.usage.output.toLocaleString()} output across ${stats.turnCount} turns.`,
    }
  },
}
