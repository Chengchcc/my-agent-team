/* eslint-disable no-console -- CLI output */

import type { CliManifest } from '../cli-types'
import { UnixSocketTransport } from '../../infrastructure/transport/unix-socket-transport'
import { existsSync } from 'node:fs'
import { defaultAgentsRoot } from '../../infrastructure/paths/agent-paths'
import { MAIN_SESSION_ID } from '../../domain/anchor'

const PROFILES_DIR = defaultAgentsRoot()

function socketPath(agentId: string): string {
  return `${PROFILES_DIR}/${agentId}/daemon.sock`
}

async function handleHeadless(agentId: string, prompt: string, sessionId = MAIN_SESSION_ID): Promise<void> {
  if (!prompt) {
    console.error('Usage: my-agent headless [-p profile] "your prompt"')
    process.exit(1)
  }

  const sp = socketPath(agentId)
  if (!existsSync(sp)) {
    console.error(`Daemon not running. Start it first: my-agent daemon start`)
    process.exit(1)
  }

  const transport = new UnixSocketTransport(sp)
  await transport.connect()

  // Resolve directly when turn completes
  let resolveTurn: () => void
  const turnDone = new Promise<void>((r) => { resolveTurn = r })

  transport.onEvent((ev) => {
    if (ev.type === 'assistant.delta') {
      process.stdout.write(String((ev.payload as Record<string, unknown>)?.delta ?? ''))
    }
    if (ev.type === 'turn.completed') { resolveTurn() }
    if (ev.type === 'turn.failed') {
      console.error('\nError:', (ev.payload as Record<string, unknown>)?.error ?? 'Turn failed')
      resolveTurn()
    }
  })

  await transport.sendRpc({ jsonrpc: '2.0', id: 'attach', method: 'session.attach', params: { sessionId } })
  await transport.sendRpc({
    jsonrpc: '2.0', id: `input-${Date.now()}`, method: 'input.send',
    params: { sessionId, text: prompt },
  })

  await turnDone
  console.log('')
  process.exit(0)
}

export const cliHeadless: CliManifest = {
  name: 'headless',
  description: 'Run a single-turn agent (no TUI)',
  usage: 'my-agent headless [-p profile] "your prompt"',
  handler: async (argv, _ctx) => {
    const rest = argv
    const pIdx = rest.indexOf('-p')
    const profile = pIdx >= 0 ? (rest[pIdx + 1] ?? 'default') : 'default'
    const sIdx = rest.indexOf('-s')
    const sessionId = sIdx >= 0 ? (rest[sIdx + 1] ?? MAIN_SESSION_ID) : MAIN_SESSION_ID
    const prompt = rest.filter(a => a !== '-p' && a !== '-s' && a !== profile && a !== sessionId).join(' ')
    await handleHeadless(profile, prompt, sessionId)
  },
}
