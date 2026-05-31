import type { CliRuntimeContext } from '../cli-types'
import { runCreateAgentFlow } from '../flows/create-agent-flow'
import { cliAgentLark } from './cli-agent-lark'

const AGENT_ID_PAD_LEN = 20

export const cliAgent = {
  name: 'agent',
  description: 'Manage agents',
  needs: ['agentStore'] as const,
  usage: [
    '  my-agent agent create',
    '  my-agent agent list',
    '  my-agent agent show -a <id>',
    '  my-agent agent init -a <id>',
    '  my-agent agent default -a <id>',
    '  my-agent agent delete -a <id>',
    '  my-agent agent lark <subcommand> -a <id>',
  ].join('\n'),
  async handler(argv: string[], ctx: CliRuntimeContext): Promise<void> {
    const sub = argv[0]
    switch (sub) {
      case 'list':
      case 'ls': {
        if (!ctx.agentStore) {
          ctx.err('agentStore not available\n')
          return
        }
        const agents = await ctx.agentStore.list()
        if (agents.length === 0) {
          ctx.out('No agents configured. Run: my-agent agent create\n')
          return
        }
        for (const a of agents) {
          const marker = a.isDefault ? '\u2605' : ' '
          ctx.out(`${marker} ${a.agentId.padEnd(AGENT_ID_PAD_LEN)} ${a.displayName} (${a.identityMode})\n`)
        }
        return
      }
      case 'create': {
        await runCreateAgentFlow(ctx)
        return
      }
      case 'show': {
        const id = getAgentArg(argv)
        if (!id) { ctx.err('Usage: my-agent agent show -a <id>\n'); return }
        if (!ctx.agentStore) { ctx.err('agentStore not available\n'); return }
        const rec = await ctx.agentStore.get(id)
        if (!rec) { ctx.err(`Agent '${id}' not found\n`); return }
        ctx.out(`Agent: ${rec.agentId}\n`)
        ctx.out(`  Display: ${rec.displayName}\n`)
        ctx.out(`  Identity: ${rec.identityMode} (${rec.identityStatus})\n`)
        ctx.out(`  Default: ${rec.isDefault ? 'yes' : 'no'}\n`)
        if (rec.larkConfig) {
          ctx.out(`  Lark: enabled=${rec.larkEnabled} appId=${rec.larkConfig.appId}\n`)
        }
        return
      }
      case 'default': {
        const id = getAgentArg(argv)
        if (!id) { ctx.err('Usage: my-agent agent default -a <id>\n'); return }
        if (!ctx.agentStore) { ctx.err('agentStore not available\n'); return }
        await ctx.agentStore.setDefault(id)
        ctx.out(`Default agent set to '${id}'\n`)
        return
      }
      case 'delete': {
        ctx.out('Use: my-agent agent delete -a <id>\n')
        return
      }
      case 'init': {
        ctx.out('Use: my-agent agent init -a <id> [--mode questionnaire|llm_oneshot|deferred]\n')
        return
      }
      case 'lark': {
        await cliAgentLark.handler(argv.slice(1), ctx)
        return
      }
      case undefined:
      default:
        ctx.err(`Unknown subcommand: ${sub ?? '(none)'}\n`)
        ctx.err(this.usage + '\n')
        process.exit(2)
    }
  },
}

function getAgentArg(argv: string[]): string | null {
  const aIdx = argv.indexOf('-a')
  if (aIdx >= 0 && aIdx + 1 < argv.length) return argv[aIdx + 1] ?? null
  const agentIdx = argv.indexOf('--agent')
  if (agentIdx >= 0 && agentIdx + 1 < argv.length) return argv[agentIdx + 1] ?? null
  return null
}
