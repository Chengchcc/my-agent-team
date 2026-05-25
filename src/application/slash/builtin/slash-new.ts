import type { SlashCommand } from '../slash-types'

export const slashNewCommand: SlashCommand = {
  name: 'new',
  description: 'Create a new session and switch to it',
  source: 'builtin',
  aliases: ['n'],
  group: 'session',
  async resolve(input, ctx) {
    const title = input.trim() || undefined
    if (!ctx.ui?.newSession) return { kind: 'handled', message: 'New session not supported in this frontend.' }
    const { sessionId } = await ctx.ui.newSession(title)
    return { kind: 'handled', message: `Created and switched to session ${sessionId}` }
  },
}
