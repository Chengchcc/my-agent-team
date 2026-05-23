import type { CliRuntimeContext } from './cli-types'
import { SqliteAgentStore } from '../infrastructure/agent/sqlite-agent-store'
import { createHomePaths, ensureHomePaths } from '../infrastructure/paths/home-paths'

function createRpcClient(_socketPath: string): CliRuntimeContext['rpc'] {
  return async (_method: string, _params?: unknown): Promise<unknown> => {
    throw new Error('RPC not available — daemon must be running')
  }
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

  return {
    agentId,
    socketPath,
    rpc: createRpcClient(socketPath),
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    agentStore,
    paths: { homeRoot: homePaths.homeRoot, agentsRoot: homePaths.agentsRoot },
  }
}

export async function disposeRuntimeContext(ctx: CliRuntimeContext): Promise<void> {
  if (ctx.agentStore && 'close' in ctx.agentStore) {
    await ctx.agentStore.close()
  }
}
