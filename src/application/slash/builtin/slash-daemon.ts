import type { SlashCommand } from '../slash-types'

export const slashDaemonCommand: SlashCommand = {
  name: 'daemon',
  description: 'Show daemon status',
  source: 'builtin',
  group: 'admin',
  async resolve(_input, ctx) {
    const health = await ctx.kernel.rpc('system.health', {}) as {
      status: string; uptimeMs: number; extensions: number
    }
    return {
      kind: 'handled',
      message: `Daemon: ${health.status} | Uptime: ${Math.round(health.uptimeMs / 1000)}s | Extensions: ${health.extensions}`,
    }
  },
}
