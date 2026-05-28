import type { CliRuntimeContext } from './cli-types'
import { SqliteAgentStore } from '../infrastructure/agent/sqlite-agent-store'
import { createHomePaths, ensureHomePaths } from '../infrastructure/paths/home-paths'
import { UnixSocketTransport } from '../infrastructure/transport/unix-socket-transport'
import { existsSync } from 'node:fs'

const RPC_REQ_ID_PREFIX = 'cli'

/**
 * Lazy, per-process RPC client over Unix socket.
 * Connection is opened on first call and reused; disposed via disposeRuntimeContext.
 */
interface RpcHolder {
  rpc: CliRuntimeContext['rpc']
  close: () => Promise<void>
}

function createRpcClient(socketPath: string): RpcHolder {
  let transport: UnixSocketTransport | null = null
  let connectPromise: Promise<void> | null = null
  let reqSeq = 0

  const ensureConnected = async (): Promise<UnixSocketTransport> => {
    if (transport) return transport
    if (!existsSync(socketPath)) {
      throw new Error(
        `daemon socket not found at ${socketPath}\n` +
        `  → start the daemon first: my-agent daemon start --agent-id=<id>`,
      )
    }
    if (!connectPromise) {
      transport = new UnixSocketTransport(socketPath)
      connectPromise = transport.connect().catch((err) => {
        transport = null
        connectPromise = null
        throw new Error(
          `failed to connect to daemon at ${socketPath}: ${err instanceof Error ? err.message : String(err)}\n` +
          `  → check the daemon is running: my-agent daemon status --agent-id=<id>`,
        )
      })
    }
    await connectPromise
    return transport!
  }

  const rpc: CliRuntimeContext['rpc'] = async (method, params) => {
    const t = await ensureConnected()
    const id = `${RPC_REQ_ID_PREFIX}-${++reqSeq}`
    const resp = await t.sendRpc({ jsonrpc: '2.0', id, method, params: params as Record<string, unknown> | undefined })
    if (!resp) throw new Error(`RPC ${method} returned no response`)
    if ('error' in resp && resp.error) {
      const e = resp.error as { code?: number; message?: string }
      throw new Error(`RPC ${method} failed: ${e.message ?? 'unknown'} (code=${e.code ?? '?'})`)
    }
    return (resp as { result?: unknown }).result
  }

  const close = async () => {
    if (transport) {
      try { await transport.close() } catch { /* ignore */ }
      transport = null
      connectPromise = null
    }
  }

  return { rpc, close }
}

export async function buildRuntimeContext(argv: string[]): Promise<CliRuntimeContext> {
  const aIdx = argv.indexOf('-a')
  const pIdx = argv.indexOf('-p')
  const agentId = (aIdx >= 0 ? argv[aIdx + 1] : null)
    ?? (pIdx >= 0 ? argv[pIdx + 1] : null)
    ?? 'default'

  const homePaths = createHomePaths()
  await ensureHomePaths(homePaths)

  const socketPath = `${homePaths.agentsRoot}/${agentId}/daemon.sock`

  const agentStore = new SqliteAgentStore(homePaths.registryDb)
  await agentStore.init()

  const rpcHolder = createRpcClient(socketPath)

  return {
    agentId,
    socketPath,
    rpc: rpcHolder.rpc,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    agentStore,
    paths: { homeRoot: homePaths.homeRoot, agentsRoot: homePaths.agentsRoot },
    _dispose: rpcHolder.close,
  }
}

export async function disposeRuntimeContext(ctx: CliRuntimeContext): Promise<void> {
  if (ctx._dispose) {
    try { await ctx._dispose() } catch { /* ignore */ }
  }
  if (ctx.agentStore && 'close' in ctx.agentStore) {
    await ctx.agentStore.close()
  }
}
