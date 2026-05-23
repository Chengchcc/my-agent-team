import { createKernel, type Kernel, type KernelConfig } from '../../src/kernel/kernel'
import { defineExtension } from '../../src/kernel/define-extension'
import type { Logger } from '../../src/application/ports/logger'
import { createAgentPaths } from '../../src/infrastructure/paths/agent-paths'
import path from 'node:path'

const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  withTag: () => silentLogger,
}

/**
 * Create a test kernel with optional extensions pre-registered.
 * Defaults: agentId='test', no extensions, silent logger.
 * When agentDir is provided, AgentPaths are computed so that
 * paths.agentDir === agentDir, preserving the test's expected directory layout.
 */
function createTestKernel(opts?: {
  agentId?: string
  agentDir?: string
  extensions?: ReturnType<typeof defineExtension>[]
  config?: Record<string, unknown>
}): Kernel {
  const pid = opts?.agentId ?? 'test'
  const root = opts?.agentDir ?? `/tmp/test-kernel-${pid}`
  // Compute paths so root matches exactly — tests assert files at agentDir/sessions/ etc.
  const paths = createAgentPaths(path.dirname(root), path.basename(root))
  const config: KernelConfig = {
    agentId: pid,
    agentDir: root,
    paths,
    config: opts?.config,
    logger: silentLogger,
  }
  const kernel = createKernel(config)
  for (const ext of opts?.extensions ?? []) {
    kernel.use(ext)
  }
  return kernel
}

export { createTestKernel }
