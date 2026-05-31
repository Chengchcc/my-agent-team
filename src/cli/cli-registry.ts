import type { CliManifest } from './cli-types'
import { cliSetup } from './commands/cli-setup'
import { cliAgent } from './commands/cli-agent'
import { cliDaemon } from './commands/cli-daemon'
import { cliSession } from './commands/cli-session'
import { cliPrint } from './commands/cli-print'
import { cliLogs } from './commands/cli-logs'

// Phase 4 ext contributions (uncomment per ext as each PR lands):
import { cliManifest as traceCli } from '../extensions/trace'
import { cliManifest as memoryCli } from '../extensions/memory'
import { cliManifest as skillsCli } from '../extensions/skills'
import { cliManifest as evolutionCli } from '../extensions/evolution'
import { cliManifest as mcpCli } from '../extensions/mcp'

export const CLI_COMMANDS: ReadonlyArray<CliManifest> = [
  cliSetup,
  cliAgent,
  cliDaemon,
  cliSession,
  cliPrint,
  cliLogs,
  skillsCli,
  traceCli,
  memoryCli,
  mcpCli,
  evolutionCli,
]

export function findCommand(name: string): CliManifest | undefined {
  return CLI_COMMANDS.find(c => c.name === name)
}
