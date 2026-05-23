import type { SlashCommand } from '../../../application/slash'
import type { EvolutionProposalsPayload } from '../widget-payloads'

const LIST_LIMIT = 20

export const slashEvolution: SlashCommand = {
  name: 'evolution',
  description: 'Review and manage evolution proposals',
  source: 'ext',
  group: 'ext',
  resolve: async (input, ctx) => {
    const argv = input.trim().split(/\s+/).slice(1)
    if (argv[0] === 'list') {
      const result = await ctx.kernel.rpc('evolution.listProposals', { limit: LIST_LIMIT })
      return {
        kind: 'render-widget',
        widget: 'evolution.proposals',
        payload: result as EvolutionProposalsPayload,
      }
    }
    if (argv[0] === 'stats') {
      const result = await ctx.kernel.rpc('evolution.stats')
      const data = result as { skills: Array<{ name: string; totalRuns: number; successfulRuns: number; lastReviewedAt: number }> }
      if (data.skills.length === 0) return { kind: 'handled', message: 'No skill stats yet.' }
      const lines = data.skills.map(s => {
        const rate = s.totalRuns > 0 ? (s.successfulRuns / s.totalRuns * 100).toFixed(0) + '%' : '-'
        return `${s.name}  ${s.totalRuns}  ${rate}  ${new Date(s.lastReviewedAt).toISOString().slice(0, 10)}`
      }).join('\n')
      return { kind: 'handled', message: `Skill stats:\n${lines}` }
    }
    if (argv[0] === 'promote' && argv[1]) {
      await ctx.kernel.rpc('evolution.promote', { id: argv[1] })
      return { kind: 'handled', message: `Proposal ${argv[1]} promoted.` }
    }
    if (argv[0] === 'discard' && argv[1]) {
      await ctx.kernel.rpc('evolution.discard', { id: argv[1] })
      return { kind: 'handled', message: `Proposal ${argv[1]} discarded.` }
    }
    return { kind: 'handled', message: 'Usage: /evolution list | /evolution stats | /evolution promote <id> | /evolution discard <id>' }
  },
}
