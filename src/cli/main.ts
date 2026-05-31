import { CLI_COMMANDS, findCommand } from './cli-registry'
import type { CliRuntimeContext } from './cli-types'
import { buildRuntimeContext, disposeRuntimeContext } from './cli-runtime'
import { parseArgv } from './args/parse'
import { FLAG_AGENT, FLAG_VERBOSE } from './args/common-flags'
import type { FlagSpec } from './args/parse'
import { Errors } from './errors/cli-error'
import { renderCliError } from './errors/render'

const COL_CMD_NAME = 12
const COL_FLAG_NAME = 14
const GLOBAL_FLAGS: FlagSpec[] = [FLAG_AGENT, FLAG_VERBOSE]

export async function main(argv: string[]): Promise<void> {
  const verbose = argv.includes('--verbose') || argv.includes('-v')
    || argv.includes('--debug') || !!process.env.MY_AGENT_DEBUG

  const parsed = parseArgv(argv, GLOBAL_FLAGS, 'permissive')
  const [cmdName, ...rest] = parsed.positional

  // --help intercept: before any I/O or DB, just render help and exit 0
  if (parsed.flags.help) {
    const cmd = cmdName ? findCommand(cmdName) : null
    if (cmd) {
      process.stdout.write(renderCommandHelp(cmd) + '\n')
    } else {
      process.stdout.write(renderGlobalHelp() + '\n')
    }
    return
  }

  if (!cmdName) {
    process.stdout.write(renderGlobalHelp() + '\n')
    return
  }

  const cmd = findCommand(cmdName)
  if (!cmd) {
    throw Errors.unknownCommand(cmdName)
  }

  let ctx: CliRuntimeContext | undefined
  try {
    ctx = await buildRuntimeContext({
      agentId: String(parsed.flags.agent ?? 'default'),
      needs: cmd.needs ?? [],
    })
    await cmd.handler(rest, ctx)
  } catch (err) {
    const { stderr, exitCode } = renderCliError(err, { verbose })
    process.stderr.write(stderr + '\n')
    // eslint-disable-next-line no-restricted-syntax -- catch block, sole exit point
    process.exit(exitCode)
  } finally {
    if (ctx) await disposeRuntimeContext(ctx)
  }
}

function renderGlobalHelp(): string {
  const lines: string[] = ['my-agent — AI agent framework', '', 'Commands:']
  for (const cmd of CLI_COMMANDS) {
    lines.push(`  ${cmd.name.padEnd(COL_CMD_NAME)} ${cmd.description}`)
  }
  lines.push('')
  lines.push('Global flags:')
  for (const flag of GLOBAL_FLAGS) {
    const alias = flag.alias ? `-${flag.alias}, ` : ''
    lines.push(`  ${alias}--${flag.name.padEnd(COL_FLAG_NAME)} ${flag.description}`)
  }
  lines.push('  -h, --help           Show this help')
  lines.push('')
  lines.push('Usage:')
  lines.push('  my-agent <command> [flags]')
  lines.push('  my-agent <command> --help')
  return lines.join('\n')
}

function renderCommandHelp(cmd: { name: string; description: string; usage: string }): string {
  const lines: string[] = [`my-agent ${cmd.name} — ${cmd.description}`, '', `Usage:`]
  for (const line of cmd.usage.split('\n')) {
    lines.push(`  ${line.trimStart()}`)
  }
  return lines.join('\n')
}
