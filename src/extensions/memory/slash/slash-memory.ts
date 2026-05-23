import type { SlashCommand } from '../../../application/slash'
import type { MemoryListPayload } from '../widget-payloads'

const LIST_LIMIT = 50
const SEARCH_LIMIT = 20

export const slashMemory: SlashCommand = {
  name: 'memory',
  description: 'List, search, and manage agent memories',
  source: 'ext',
  group: 'ext',
  resolve: async (input, ctx) => {
    const argv = input.trim().split(/\s+/).slice(1)
    if (argv[0] === 'list') {
      const result = await ctx.kernel.rpc('memory.list', { limit: LIST_LIMIT })
      return {
        kind: 'render-widget',
        widget: 'memory.list',
        payload: result as MemoryListPayload,
      }
    }
    if (argv[0] === 'search' && argv[1]) {
      const result = await ctx.kernel.rpc('memory.search', { query: argv[1], limit: SEARCH_LIMIT })
      return {
        kind: 'render-widget',
        widget: 'memory.list',
        payload: result as MemoryListPayload,
      }
    }
    if (argv[0] === 'forget' && argv[1]) {
      const result = await ctx.kernel.rpc('memory.forget', { id: argv[1] })
      const data = result as { removed: boolean }
      return { kind: 'handled', message: data.removed ? `Forgot ${argv[1]}` : `Not found: ${argv[1]}` }
    }
    return { kind: 'handled', message: 'Usage: /memory list | /memory search <query> | /memory forget <id>' }
  },
}
