/* eslint-disable no-console -- CLI output */

import { CLI_COMMANDS, findCommand } from './cli-registry'
import type { CliRuntimeContext } from './cli-types'
import { buildRuntimeContext, disposeRuntimeContext } from './cli-runtime'

const COL_CMD_NAME = 12

export async function main(argv: string[]): Promise<void> {
  const [cmdName, ...rest] = argv
  if (!cmdName || cmdName === '--help' || cmdName === '-h') {
    printHelp()
    return
  }
  const cmd = findCommand(cmdName)
  if (!cmd) {
    console.error(`unknown command: ${cmdName}`)
    printHelp()
    process.exit(2)
  }
  const ctx: CliRuntimeContext = await buildRuntimeContext({
    agentId: 'default',  // Phase 1 will parse --agent from argv
    needs: cmd.needs ?? [],
  })
  try {
    await cmd.handler(rest, ctx)
  } finally {
    await disposeRuntimeContext(ctx)
  }
}

function printHelp() {
  console.log('my-agent — AI agent framework\n')
  console.log('Commands:')
  for (const cmd of CLI_COMMANDS) {
    console.log(`  ${cmd.name.padEnd(COL_CMD_NAME)} ${cmd.description}`)
  }
  console.log('Global flags: -a, --agent <id>  Use: my-agent <command> --help')
}
