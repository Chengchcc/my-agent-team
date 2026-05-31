import type { CliRuntimeContext } from '../cli-types'
import { runCreateAgentFlow } from '../flows/create-agent-flow'

export const cliSetup = {
  name: 'setup',
  description: 'Interactive setup (alias for agent create)',
  needs: ['agentStore'] as const,
  usage: '  my-agent setup',
  async handler(_argv: string[], ctx: CliRuntimeContext): Promise<void> {
    await runCreateAgentFlow(ctx)
  },
}
