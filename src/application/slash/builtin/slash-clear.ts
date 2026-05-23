import type { SlashCommand } from '../slash-types'

export const slashClearCommand: SlashCommand = {
  name: 'clear',
  description: 'Clear the current session transcript',
  source: 'builtin',
  aliases: ['cls'],
  group: 'session',
  async resolve(_input, ctx) {
    await ctx.kernel.rpc('session.clear', { sessionId: ctx.sessionId })
    ctx.ui?.clearTranscript?.()
    return { kind: 'handled', message: 'Session cleared.' }
  },
}
