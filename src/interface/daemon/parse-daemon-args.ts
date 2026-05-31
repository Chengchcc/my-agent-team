import type { DaemonOptions } from './types'

function getFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag)
  return idx >= 0 ? argv[idx + 1] : undefined
}

export function parseDaemonArgs(argv: string[]): DaemonOptions {
  const agentId = getFlag(argv, '--agent')
    ?? getFlag(argv, '-a')
    ?? 'default'
  const agentsRoot = getFlag(argv, '--agents-root')
    ?? process.env.MY_AGENT_AGENTS_ROOT
    ?? process.env.MY_AGENT_PROFILE_ROOT
  const socketPath = getFlag(argv, '--socket')  // test/debug only
  return { agentId, agentsRoot, socketPath }
}
