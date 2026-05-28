/* eslint-disable no-console -- CLI output */

import type { CliManifest } from '../cli-types'
import { UnixSocketTransport } from '../../infrastructure/transport/unix-socket-transport'
import type { Transport } from '../../application/ports/transport'
import { defaultAgentsRoot } from '../../infrastructure/paths/agent-paths'
import { MAIN_SESSION_ID } from '../../domain/anchor'

const PROFILES_DIR = defaultAgentsRoot()

function getSessionAgentId(argv: string[]): string {
  const aIdx = argv.indexOf('-a')
  if (aIdx >= 0 && aIdx + 1 < argv.length) return argv[aIdx + 1] ?? 'default'
  const pIdx = argv.indexOf('-p')
  if (pIdx >= 0 && pIdx + 1 < argv.length) return argv[pIdx + 1] ?? 'default'
  return 'default'
}

function socketPath(agentId: string): string {
  return `${PROFILES_DIR}/${agentId}/daemon.sock`
}

async function handleAttachTUI(transport: Transport, sid?: string): Promise<void> {
  const { TUIAdapter } = await import('../../extensions/frontend.tui/index')
  const { runTUIClient } = await import('../../extensions/frontend.tui/run-tui')
  const { TranscriptProjector } = await import('../../extensions/frontend.tui/transcript/projector')
  const sessionId = sid ?? MAIN_SESSION_ID
  const adapter = new TUIAdapter('cli-tui', transport)
  await adapter.start()

  const client = adapter.createSessionClient()

  // Attach and get history snapshot
  const attachResult = await client.attachSession(sid)
  const snapshot = attachResult.snapshot ?? []

  const projector = new TranscriptProjector()

  const inkInstance = runTUIClient(client, projector, sessionId, snapshot as unknown[] as Array<{ role: string; content: unknown }>)
  await inkInstance.waitUntilExit()
  projector.destroy()
  await adapter.stop()
}

async function handleAttachText(transport: Transport, sid?: string): Promise<void> {
  const r = await transport.sendRpc({
    jsonrpc: '2.0', id: 'attach', method: 'session.attach',
    params: sid ? { sessionId: sid } : {},
  })
  console.log('Attached:', r?.result ?? 'ok')
  console.log('\n--- Agent output ---\n')
  const unsub = transport.onEvent((ev) => {
    if (ev.type === 'assistant.delta') {
      process.stdout.write(String((ev.payload as Record<string, unknown>)?.delta ?? ''))
    }
    if (ev.type === 'turn.completed') console.log('\n--- Turn complete ---\n')
  })

  const readline = (await import('node:readline')).createInterface({
    input: process.stdin, output: process.stdout, prompt: '\nYou > ',
  })
  readline.prompt()

  await new Promise<void>((resolveDetach) => {
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- fire-and-forget within Promise wrapper
    readline.on('line', async (line) => {
      const text = line.trim()
      if (text === '/exit' || text === '/quit' || text === '/detach') {
        await transport.sendRpc({
          jsonrpc: '2.0', id: 'detach', method: 'session.detach',
          params: { sessionId: sid ?? MAIN_SESSION_ID },
        })
        unsub(); readline.close()
        console.log('Detached.')
        resolveDetach()
        return
      }
      await transport.sendRpc({
        jsonrpc: '2.0', id: `input-${Date.now()}`, method: 'input.send',
        params: { sessionId: sid ?? MAIN_SESSION_ID, text },
      })
      readline.prompt()
    })
  })
}

async function handleSessionAttach(agentId: string, sid?: string, textMode?: boolean): Promise<void> {
  const transport = new UnixSocketTransport(socketPath(agentId))
  try {
    await transport.connect()
    if (textMode) await handleAttachText(transport, sid)
    else await handleAttachTUI(transport, sid)
  } finally { await transport.close() }
}

async function handleSessionList(agentId: string): Promise<void> {
  const transport = new UnixSocketTransport(socketPath(agentId))
  try {
    await transport.connect()
    const r = await transport.sendRpc({
      jsonrpc: '2.0', id: 'list', method: 'session.list', params: {},
    })
    const sessions = ((r?.result as Record<string, unknown>)?.sessions ?? []) as Array<Record<string, unknown>>
    if (sessions.length === 0) { console.log('No sessions.'); return }
    console.log(`\nSessions (${agentId}):\n`)
    for (const s of sessions) {
      console.log(`  ${s.sessionId ?? s.id}  ${s.title ?? ''}  [${s.state ?? ''}] ${s.isMain ? '(main)' : ''}`)
    }
    console.log('')
  } finally { await transport.close() }
}

async function handleSessionCreate(agentId: string, title?: string): Promise<void> {
  const transport = new UnixSocketTransport(socketPath(agentId))
  try {
    await transport.connect()
    const r = await transport.sendRpc({
      jsonrpc: '2.0', id: 'create', method: 'session.create',
      params: title ? { title } : {},
    })
    console.log('Session created:', (r?.result as Record<string, unknown>)?.sessionId ?? (r?.result as Record<string, unknown>)?.id ?? 'ok')
  } finally { await transport.close() }
}

async function handleSessionResume(agentId: string, sessionId: string): Promise<void> {
  const transport = new UnixSocketTransport(socketPath(agentId))
  try {
    await transport.connect()
    await transport.sendRpc({
      jsonrpc: '2.0', id: 'resume', method: 'session.resume',
      params: { sessionId },
    })
    await handleAttachTUI(transport, sessionId)
  } finally { await transport.close() }
}

export const cliSession: CliManifest = {
  name: 'session',
  description: 'Manage sessions',
  usage: 'my-agent session <attach|list|create|resume> [args]',
  handler: async (argv, _ctx) => {
    const sub = argv[0] ?? ''
    switch (sub) {
      case 'attach': {
        const rest = argv.slice(1)
        const textMode = rest.includes('--text')
        const agentId = getSessionAgentId(rest)
        const sIdx = rest.indexOf('-s')
        const sessionId = sIdx >= 0 ? (rest[sIdx + 1] ?? undefined) : undefined
        await handleSessionAttach(agentId, sessionId, textMode)
        return
      }
      case 'list':
      case 'ls': {
        const rest = argv.slice(1)
        await handleSessionList(getSessionAgentId(rest))
        return
      }
      case 'create': {
        const rest = argv.slice(1)
        const agentId = getSessionAgentId(rest)
        await handleSessionCreate(agentId, rest.filter(a => a !== '-a' && a !== '-p' && a !== agentId)[0])
        return
      }
      case 'resume': {
        const rest = argv.slice(1)
        const agentId = getSessionAgentId(rest)
        await handleSessionResume(agentId, rest.filter(a => a !== '-a' && a !== '-p' && a !== agentId)[0] ?? MAIN_SESSION_ID)
        return
      }
      default: {
        console.error('Usage: my-agent session <attach|list|create|resume> [args]')
        process.exit(1)
      }
    }
  },
}
