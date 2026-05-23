import type { CliRuntimeContext } from '../cli-types'
import { createPrompts } from '../prompts/prompt-runner'
import { runLarkFlow } from '../flows/lark-flow'

export const cliAgentLark = {
  name: 'agent-lark',
  description: 'Manage Lark bot configuration for an agent',
  usage: [
    '  my-agent agent lark set     -a <id>',
    '  my-agent agent lark show    -a <id>',
    '  my-agent agent lark test    -a <id>',
    '  my-agent agent lark unset   -a <id>',
    '  my-agent agent lark enable  -a <id>',
    '  my-agent agent lark disable -a <id>',
  ].join('\n'),
  async handler(argv: string[], ctx: CliRuntimeContext): Promise<void> {
    const id = getLarkAgentArg(argv)
    if (!id) { ctx.err('Usage: -a <agentId> required\n'); return }
    if (!ctx.agentStore) { ctx.err('agentStore not available\n'); return }
    const rec = await ctx.agentStore.get(id)
    if (!rec) { ctx.err(`Agent '${id}' not found\n`); return }

    const sub = argv[0]
    switch (sub) {
      case 'show': {
        if (!rec.larkConfig) { ctx.out(`Agent '${id}': no Lark config\n`); return }
        ctx.out(`Agent: ${id}\n`)
        ctx.out(`  Lark Bot:    ${rec.larkEnabled ? 'enabled' : 'disabled'}\n`)
        ctx.out(`  App ID:      ${rec.larkConfig.appId}\n`)
        ctx.out(`  Secret env:  ${rec.larkConfig.appSecretEnv}`)
        const envPresent = process.env[rec.larkConfig.appSecretEnv] != null
        ctx.out(`    [${envPresent ? '\u2713' : '\u2717'} env ${envPresent ? 'present' : 'missing'}]\n`)
        if (rec.larkLastTestAt) {
          ctx.out(`  Last test:   ${new Date(rec.larkLastTestAt).toISOString()} ${rec.larkLastTestOk ? '\u2713 ok' : '\u2717 failed'}\n`)
        }
        return
      }
      case 'set': {
        const prompts = createPrompts()
        const result = await runLarkFlow(prompts, {
          initial: rec.larkConfig,
          smokeCheck: 'ask',
        })
        await ctx.agentStore.setLarkConfig(id, result.config)
        ctx.out(`Lark config saved for agent '${id}'\n`)
        return
      }
      case 'unset': {
        if (!rec.larkConfig) { ctx.out('No Lark config to remove\n'); return }
        await ctx.agentStore.unsetLarkConfig(id)
        ctx.out(`Lark config removed for agent '${id}'\n`)
        return
      }
      case 'enable': {
        await ctx.agentStore.setLarkEnabled(id, true)
        ctx.out(`Lark enabled for agent '${id}'\n`)
        return
      }
      case 'disable': {
        await ctx.agentStore.setLarkEnabled(id, false)
        ctx.out(`Lark disabled for agent '${id}'\n`)
        return
      }
      case 'test':
        ctx.out('Lark smoke test — coming soon\n')
        return
      case undefined:
      default:
        ctx.err(`Unknown lark subcommand: ${sub ?? '(none)'}\n`)
        ctx.err(this.usage + '\n')
        process.exit(2)
    }
  },
}

function getLarkAgentArg(argv: string[]): string | null {
  const aIdx = argv.indexOf('-a')
  if (aIdx >= 0 && aIdx + 1 < argv.length) return argv[aIdx + 1] ?? null
  return null
}
