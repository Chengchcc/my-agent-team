import type { SlashCommand } from '../../../application/slash'
import type { TraceShowPayload, TraceListPayload } from '../widget-payloads'

const LIST_LIMIT = 20

export const slashTrace: SlashCommand = {
  name: 'trace',
  description: 'Inspect trace runs',
  source: 'ext',
  group: 'ext',
  resolve: async (input, ctx) => {
    const argv = input.trim().split(/\s+/).slice(1)
    if (argv[0] === 'show' && argv[1]) {
      const result = await ctx.kernel.rpc('trace.getRun', { runId: argv[1] })
      return {
        kind: 'render-widget',
        widget: 'trace.show',
        payload: result as TraceShowPayload,
      }
    }
    if (argv[0] === 'list') {
      const result = await ctx.kernel.rpc('trace.listRecent', { limit: LIST_LIMIT })
      return {
        kind: 'render-widget',
        widget: 'trace.list',
        payload: result as TraceListPayload,
      }
    }
    return { kind: 'handled', message: 'Usage: /trace list | /trace show <runId>' }
  },
}
