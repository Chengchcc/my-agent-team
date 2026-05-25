import type { SlashCommand } from '../slash-types'

export const slashResumeCommand: SlashCommand = {
  name: 'resume',
  description: 'Switch to an existing session by id or index',
  source: 'builtin',
  aliases: ['sw'],
  group: 'session',
  async resolve(input, ctx) {
    const id = input.trim()
    if (!id) {
      ctx.ui?.openSessionPicker?.()
      return { kind: 'handled' }
    }
    if (!ctx.ui?.switchSession) return { kind: 'handled', message: 'Session switch not supported in this frontend.' }
    await ctx.ui.switchSession(id)
    return { kind: 'handled', message: `Switched to session ${id}` }
  },
}
