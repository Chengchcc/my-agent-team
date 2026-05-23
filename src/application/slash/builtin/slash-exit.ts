import type { SlashCommand } from '../slash-types'

export const slashExitCommand: SlashCommand = {
  name: 'exit',
  description: 'Shut down the daemon',
  source: 'builtin',
  aliases: ['quit'],
  group: 'admin',
  async resolve(_input, ctx) {
    await ctx.kernel.rpc('system.shutdown', {})
    return { kind: 'handled', message: 'Shutting down...' }
  },
}
