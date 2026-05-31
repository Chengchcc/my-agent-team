import path from 'node:path'
import fs from 'node:fs/promises'
import { createKernel } from '../../kernel/kernel'
import type { DaemonOptions, DaemonHandle } from './types'
import { domainCore, memory, identity, skills, evolution, mcp, infraServices, transportInmem, transportUnix, frontendLark, frontendCapabilityHints } from '../../extensions/presets'
import { MB } from '../../application/constants/units'
import { FileLogger } from '../../infrastructure/logging/file-logger'
import { createAgentPaths, ensureAgentPaths, defaultAgentsRoot } from '../../infrastructure/paths/agent-paths'
import { SqliteAgentStore } from '../../infrastructure/agent/sqlite-agent-store'
import { createAgentRegistryRead, createAgentSelfMutator } from '../../infrastructure/agent/agent-registry-impl'
import { createHomePaths, ensureHomePaths } from '../../infrastructure/paths/home-paths'
import { AgentNotFoundError } from '../../infrastructure/agent/sqlite-agent-store'

export { AgentNotFoundError }
import { CliError } from '../../cli/errors/cli-error'
import { renderIdentityMd } from '../../domain/identity-doc'
import { atomicWrite } from '../../shared/atomic-write'

async function seedDefault(
  paths: ReturnType<typeof createAgentPaths>,
  agentStore: SqliteAgentStore,
  logger: FileLogger,
): Promise<NonNullable<Awaited<ReturnType<SqliteAgentStore['get']>>>> {
  // If a default agent already exists (e.g. from a previous run in the same home),
  // return it instead of failing with UNIQUE constraint on is_default.
  const existing = await agentStore.getDefault()
  if (existing) return existing

  const identityMd = renderIdentityMd(
    { role: 'Engineering Assistant', audience: '开发团队', tone: 'concise, helpful', expertise: 'TypeScript, distributed systems, debugging' },
    '# Identity\n\nYou are a general-purpose coding assistant. Be helpful, concise, and accurate.\n'
  )
  await fs.mkdir(paths.identity.dir, { recursive: true })
  await atomicWrite(paths.identity.file, identityMd)
  const record = {
    agentId: 'default', displayName: 'Default Agent',
    createdAt: Date.now(), updatedAt: Date.now(), isDefault: true,
    identityMode: 'questionnaire' as const, identityStatus: 'ready' as const,
    identityPath: paths.identity.file, bootstrapPath: null as string | null,
    larkConfig: null as null, larkEnabled: false, larkLastTestAt: null as number | null, larkLastTestOk: null as (0 | 1 | null),
  }
  await agentStore.create(record)
  logger.info('daemon', 'seeded default agent for first run')
  return record
}

function registerTransport(
  kernel: ReturnType<typeof createKernel>,
  opts: DaemonOptions,
  socketPath: string,
): void {
  if (opts.transport === 'inmem') {
    for (const ext of transportInmem) kernel.use(ext)
  } else {
    for (const ext of transportUnix({ socketPath })) kernel.use(ext)
  }
}

function registerLarkIfEnabled(
  kernel: ReturnType<typeof createKernel>,
  record: NonNullable<Awaited<ReturnType<SqliteAgentStore['get']>>>,
  opts: DaemonOptions,
): void {
  if (record.larkConfig != null && record.larkEnabled) {
    if (opts.transport !== 'inmem') {
      for (const ext of transportInmem) kernel.use(ext)
    }
    for (const ext of frontendLark) kernel.use(ext)
  }
}

async function startLarkBot(
  kernel: ReturnType<typeof createKernel>,
  record: NonNullable<Awaited<ReturnType<SqliteAgentStore['get']>>>,
  agentId: string,
  logger: FileLogger,
): Promise<void> {
  const larkCap = kernel.ctx.extensions.get('frontend-lark.lark')
  if (!larkCap) return

  const appSecret = process.env[record.larkConfig!.appSecretEnv]
  if (!appSecret) {
    logger.warn('lark', `env var ${record.larkConfig!.appSecretEnv} not set — Lark bot not started`)
    return
  }
  const bot = larkCap.createBot({
    id: `lark-bot-${agentId}`,
    appId: record.larkConfig!.appId,
    appSecretEnv: appSecret,
  })
  await bot.start()
  logger.info('lark', `bot started for agent ${agentId}`)
}

export async function bootstrap(opts: DaemonOptions): Promise<DaemonHandle> {
  const agentsRoot = opts.agentsRoot ?? defaultAgentsRoot()
  const paths = createAgentPaths(agentsRoot, opts.agentId)
  const socketPath = opts.socketPath ?? paths.socket

  const SOCKET_PATH_MAX_BYTES = 104
  if (Buffer.byteLength(socketPath) >= SOCKET_PATH_MAX_BYTES) {
    throw new CliError({
      code: 'E_SOCKET_PATH_TOO_LONG',
      message: `Socket path too long (${socketPath.length} bytes).`,
      hint: 'Set MY_AGENT_AGENTS_ROOT to a shorter path.',
      exitCode: 2,
    })
  }

  await ensureAgentPaths(paths)

  // Wire file-backed logging so kernel/debug output goes to disk, not stderr.
  const logPath = path.join(paths.logs, 'agent.log')
  const logger = new FileLogger({ path: logPath, level: 'info', maxSize: 10 * MB, maxFiles: 5 })

  // Create home paths and agent store
  const home = createHomePaths()
  await ensureHomePaths(home)
  const agentStore = new SqliteAgentStore(home.registryDb)
  await agentStore.init()

  let record = await agentStore.get(opts.agentId)
  if (!record) {
    if (opts.agentId === 'default') {
      record = await seedDefault(paths, agentStore, logger)
    } else {
      throw new AgentNotFoundError(opts.agentId)
    }
  }

  if (record.identityStatus === 'pending_bootstrap') {
    logger.info('daemon', `agent ${record.agentId} is in bootstrap mode (deferred identity)`)
  }

  const kernel = createKernel({
    agentId: opts.agentId,
    agentDir: paths.agentDir,
    paths,
    logger,
  })

  // Register kernel-level capabilities (environment-dependent singletons → provideKernel)
  const registry = createAgentRegistryRead(agentStore, opts.agentId)
  const selfMutator = createAgentSelfMutator(agentStore, opts.agentId)
  kernel.ctx.extensions.provideKernel('agent.store', agentStore)
  kernel.ctx.extensions.provideKernel('agent.registry', registry)
  kernel.ctx.extensions.provideKernel('agent.self', selfMutator)

  for (const ext of domainCore) kernel.use(ext)
  for (const ext of memory()) kernel.use(ext)
  for (const ext of identity) kernel.use(ext)
  for (const ext of skills()) kernel.use(ext)
  for (const ext of evolution) kernel.use(ext)
  for (const ext of mcp) kernel.use(ext)
  for (const ext of infraServices) kernel.use(ext)
  for (const ext of frontendCapabilityHints) kernel.use(ext)

  registerTransport(kernel, opts, socketPath)
  for (const ext of (opts.extraExtensions ?? [])) kernel.use(ext)
  registerLarkIfEnabled(kernel, record, opts)
  await kernel.start()

  if (record.larkConfig != null && record.larkEnabled) {
    await startLarkBot(kernel, record, opts.agentId, logger)
  }

  return {
    kernel,
    agentDir: paths.agentDir,
    socketPath,
    stop: once(async () => { await kernel.stop() }),
  }
}

function once<T extends (...args: unknown[]) => unknown>(fn: T): T {
  let called = false
  return ((...args: unknown[]) => {
    if (called) return
    called = true
    return fn(...args)
  }) as T
}
