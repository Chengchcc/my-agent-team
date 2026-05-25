import type { SlashCommand } from '../slash-types'

export const slashSessionsCommand: SlashCommand = {
  name: 'sessions',
  description: 'List and switch sessions',
  source: 'builtin',
  aliases: ['ls'],
  group: 'session',
  async resolve(_input, ctx) {
    ctx.ui?.openSessionPicker?.()
    return { kind: 'handled' }
  },
}
