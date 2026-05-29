import type { JobSpawner } from '../../application/ports/job-spawner'
import type { ProviderInvoke, ProviderChat } from '../../application/ports/provider'
import type { Logger } from '../../application/ports/logger'
import { BunSpawnJobSpawner } from './bun-spawn-job-spawner'
import { InprocJobSpawner } from './inproc-job-spawner'

export function createJobSpawner(opts?: {
  invoke?: ProviderInvoke
  chatComplete?: ProviderChat['complete']
  logger?: Logger
}): JobSpawner {
  const mode = process.env.JOB_SPAWNER ?? 'spawn'
  if (mode === 'spawn') {
    if (!opts?.invoke || !opts?.logger) {
      throw new Error(
        'JOB_SPAWNER=spawn requires ProviderInvoke and Logger — ' +
        'pass { invoke, logger } to createJobSpawner()',
      )
    }
    return new BunSpawnJobSpawner(
      opts.invoke,
      opts.chatComplete ?? (async () => ({ id: '', content: '', finishReason: 'stop' as const, usage: { input: 0, output: 0 }, model: '' })),
      opts.logger,
      { invokeTimeoutMs: 60_000, lifetimeMs: 300_000 },
    )
  }
  return new InprocJobSpawner()
}
