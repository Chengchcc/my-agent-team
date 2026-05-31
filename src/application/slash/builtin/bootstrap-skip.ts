import type { SlashCommand } from '../slash-types'

export const bootstrapSkip: SlashCommand = {
  name: 'bootstrap',
  description: 'Skip the bootstrap identity initialization',
  source: 'builtin',
  group: 'session',
  aliases: ['bs'],
  async resolve(_input, ctx) {
    const result = await ctx.kernel.rpc('agent.bootstrap.skip', {})
    const r = result as { ok?: boolean; error?: string }
    if (r?.error) {
      await ctx.reply.notice?.(`跳过失败：${r.error}`)
      return { kind: 'handled' }
    }
    await ctx.reply.notice?.('已跳过身份初始化')
    return { kind: 'handled' }
  },
}
