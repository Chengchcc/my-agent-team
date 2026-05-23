import { ExtensionRegistry } from './extension-registry'
import { HookContainer } from './hook-container'
import { EventBus } from './event-bus'
import { RpcRegistry } from './rpc-registry'
import { topoSort } from './topo-sort'
import type { ExtensionBuilder } from './define-extension'
import type { KernelContext, Clock, Logger } from './kernel-context'
import { createAgentPaths, defaultAgentsRoot } from '../infrastructure/paths/agent-paths'
import type { AgentPaths } from '../infrastructure/paths/agent-paths'
import path from 'node:path'

interface KernelConfig {
  agentId: string
  agentDir?: string
  paths?: AgentPaths
  config?: Record<string, unknown>
  clock?: Clock
  logger?: Logger
}

interface Kernel {
  use(ext: ExtensionBuilder): Kernel
  start(): Promise<void>
  stop(): Promise<void>
  readonly ctx: KernelContext
}

/** @public — core kernel factory */
function createKernel(config: KernelConfig): Kernel {
  const pendingExtensions: ExtensionBuilder[] = []
  const extensions = new ExtensionRegistry()
  const hooks = new HookContainer()
  const bus = new EventBus()
  const rpc = new RpcRegistry()

  const clock: Clock = config.clock ?? { now: () => Date.now() }
  const makeStderrLogger = (tag: string): Logger => ({
    debug: (_, msg) => { process.stderr.write(`[DEBUG] [${tag}] ${msg}\n`) },
    info:  (_, msg) => { process.stderr.write(`[INFO]  [${tag}] ${msg}\n`) },
    warn:  (_, msg) => { process.stderr.write(`[WARN]  [${tag}] ${msg}\n`) },
    error: (_, msg) => { process.stderr.write(`[ERROR] [${tag}] ${msg}\n`) },
    withTag: (t) => makeStderrLogger(t),
  })
  const logger: Logger = config.logger ?? makeStderrLogger('kernel')

  // Inject logger into error-reporting subsystems so they don't fall back to console.warn.
  bus.setLogger(logger)
  hooks.setLogger(logger)

  const agentsRoot = config.agentDir
    ? path.dirname(config.agentDir)
    : defaultAgentsRoot()

  const ctx: KernelContext = {
    agentId: config.agentId,
    agentDir: config.agentDir ?? path.join(agentsRoot, config.agentId),
    paths: config.paths ?? createAgentPaths(agentsRoot, config.agentId),
    extensions,
    bus,
    hooks,
    rpc,
    clock,
    logger,
    config: config.config ?? {},
  }

  let started = false
  let orderedExtensions: ExtensionBuilder[] = []

  const kernel: Kernel = {
    ctx,

    use(ext: ExtensionBuilder): Kernel {
      if (started) {
        throw new Error('Cannot add extensions after kernel has started')
      }
      pendingExtensions.push(ext)
      return kernel
    },

    async start(): Promise<void> {
      if (started) return

      // Step 1: Topological sort
      orderedExtensions = topoSort([...pendingExtensions])
      logger.info('kernel', `${orderedExtensions.length} extensions sorted: ${orderedExtensions.map(e => e.name).join(', ')}`)

      // Step 2: Apply each extension in order — INV-Kernel-3: apply is pure registration
      for (const builder of orderedExtensions) {
        const t0 = Date.now()
        const result = await builder.apply(ctx)
        extensions.register(builder, result)
        logger.debug('kernel', `extension "${builder.name}" applied (${Date.now() - t0}ms)`)

        // Register hooks
        if (result.hooks) {
          for (const [hookName, handler] of Object.entries(result.hooks)) {
            hooks.register(builder.name, builder.enforce, hookName, handler)
          }
        }

        // Subscribe to bus events
        if (result.subscribe) {
          for (const [event, handler] of Object.entries(result.subscribe)) {
            bus.on(event, handler as (payload: unknown) => void | Promise<void>)
          }
        }

        // Register RPC handlers in dedicated RpcRegistry (O(1) dispatch)
        if (result.rpc) {
          const methods = Object.keys(result.rpc)
          for (const [method, handler] of Object.entries(result.rpc)) {
            rpc.register(method, handler as (params: unknown) => unknown | Promise<unknown>)
          }
          logger.debug('kernel', `RPC methods from "${builder.name}": ${methods.join(', ')}`)
        }
      }

      // Step 3: configureKernel hook (sequential)
      await hooks.dispatch('configureKernel')

      // Step 4: kernelReady hook (parallel)
      logger.info('kernel', 'dispatching kernelReady...')
      await hooks.dispatch('kernelReady')

      started = true
      logger.info('kernel', `started with ${orderedExtensions.length} extensions`)
    },

    async stop(): Promise<void> {
      if (!started) return
      logger.info('kernel', 'shutting down...')

      // Shutdown hooks in reverse registration order
      await hooks.dispatch('onShutdown')

      // Dispose extensions in reverse order
      for (const builder of [...orderedExtensions].reverse()) {
        const instance = extensions.getExtension(builder.name)
        if (instance?.result.dispose) {
          try {
            await instance.result.dispose()
          } catch (err) {
            logger.warn('kernel', `dispose error for "${builder.name}": ${String(err)}`)
          }
        }
        hooks.unregisterExtension(builder.name)
        extensions.unregister(builder.name)
      }

      bus.clear()
      hooks.clear()
      rpc.clear()
      orderedExtensions = []
      started = false
    },
  }

  return kernel
}

export { createKernel }
export type { Kernel, KernelConfig }
