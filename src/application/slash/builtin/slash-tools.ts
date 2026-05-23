import type { SlashCommand } from '../slash-types'

export const slashToolsCommand: SlashCommand = {
  name: 'tools',
  description: 'List available tools',
  source: 'builtin',
  group: 'tooling',
  async resolve(_input, ctx) {
    const result = await ctx.kernel.rpc('tool.list', {}) as {
      tools: Array<{ name: string; description: string }>
    }
    const lines = result.tools.map(t => `  **/${t.name}** — ${t.description}`)
    return { kind: 'handled', message: `Available tools (${result.tools.length}):\n${lines.join('\n')}` }
  },
}
