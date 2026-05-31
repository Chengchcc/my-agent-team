import type { CliManifest } from '../cli-types'
import { UnixSocketTransport } from '../../infrastructure/transport/unix-socket-transport'
import { existsSync } from 'node:fs'
import { defaultAgentsRoot } from '../../infrastructure/paths/agent-paths'
import { MAIN_SESSION_ID } from '../../domain/anchor'
import { Errors } from '../errors/cli-error'

const PROFILES_DIR = defaultAgentsRoot()

function socketPath(agentId: string): string {
  return `${PROFILES_DIR}/${agentId}/daemon.sock`
}

async function handlePrint(agentId: string, prompt: string, sessionId = MAIN_SESSION_ID): Promise<void> {
  if (!prompt) {
    throw Errors.missingPrompt()
  }

  const sp = socketPath(agentId)
  if (!existsSync(sp)) {
    throw Errors.daemonNotRunning(agentId, sp)
  }

  const transport = new UnixSocketTransport(sp)
  await transport.connect()

  let resolveTurn: () => void
  const turnDone = new Promise<void>((r) => { resolveTurn = r })

  transport.onEvent((ev) => {
    if (ev.type === 'assistant.delta') {
      process.stdout.write(String((ev.payload as Record<string, unknown>)?.delta ?? ''))
    }
    if (ev.type === 'turn.completed') { resolveTurn() }
    if (ev.type === 'turn.failed') {
      throw Errors.turnFailed(String((ev.payload as Record<string, unknown>)?.error ?? 'Turn failed'))
    }
  })

  await transport.sendRpc({ jsonrpc: '2.0', id: 'attach', method: 'session.attach', params: { sessionId } })
  await transport.sendRpc({
    jsonrpc: '2.0', id: `input-${Date.now()}`, method: 'input.send',
    params: { sessionId, text: prompt },
  })

  await turnDone
  process.stdout.write('\n')
}

export const cliPrint: CliManifest = {
  name: 'print',
  description: 'Run a single-turn agent non-interactively (stdin/stdout)',
  usage: 'my-agent print [flags] "<prompt>"',
  needs: [],
  handler: async (argv, ctx) => {
    const rest = argv
    const sIdx = rest.indexOf('-s')
    const sessionId = sIdx >= 0 ? (rest[sIdx + 1] ?? MAIN_SESSION_ID) : MAIN_SESSION_ID
    const prompt = rest.filter(a => a !== '-s' && a !== sessionId).join(' ')
    await handlePrint(ctx.agentId, prompt, sessionId)
  },
}
