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
  rpc: NonNullable<CliRuntimeContext['rpc']>
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
        `  → start the daemon first: my-agent daemon start --agent <id>`,
      )
    }
    if (!connectPromise) {
      transport = new UnixSocketTransport(socketPath)
      connectPromise = transport.connect().catch((err) => {
        transport = null
        connectPromise = null
        throw new Error(
          `failed to connect to daemon at ${socketPath}: ${err instanceof Error ? err.message : String(err)}\n` +
          `  → check the daemon is running: my-agent daemon status --agent <id>`,
        )
      })
    }
    await connectPromise
    return transport!
  }

  const rpc: NonNullable<CliRuntimeContext['rpc']> = async (method, params) => {
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

export function requireRpc(ctx: CliRuntimeContext): NonNullable<CliRuntimeContext['rpc']> {
  if (!ctx.rpc) throw new Error('internal: command did not declare needs:["rpc"]')
  return ctx.rpc
}

export async function buildRuntimeContext(
  opts: { agentId: string; needs: ReadonlyArray<'agentStore' | 'rpc'> },
): Promise<CliRuntimeContext> {
  const agentId = opts.agentId
  const homePaths = createHomePaths()
  try { await ensureHomePaths(homePaths) } catch (err) {
    throw new Error(`Could not prepare agent storage directory: ${homePaths.agentsRoot} — ${String(err)}`)
  }

  const socketPath = `${homePaths.agentsRoot}/${agentId}/daemon.sock`

  let agentStore
  if (opts.needs.includes('agentStore')) {
    const store = new SqliteAgentStore(homePaths.registryDb)
    try { await store.init() } catch (err) {
      throw new Error(`Could not open agent registry database at ${homePaths.registryDb}: ${String(err)}`)
    }
    agentStore = store
  }

  let rpcHolder: RpcHolder | undefined
  if (opts.needs.includes('rpc')) {
    rpcHolder = createRpcClient(socketPath)
  }

  return {
    agentId,
    socketPath,
    rpc: rpcHolder?.rpc,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    agentStore,
    paths: { homeRoot: homePaths.homeRoot, agentsRoot: homePaths.agentsRoot },
    _dispose: rpcHolder?.close,
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
