/// <reference types="bun" />

import type { JobContext, JobSpawner } from '../../application/ports/job-spawner'

export class BunSpawnJobSpawner implements JobSpawner {
  async run<TJob, TResult>(opts: {
    entry: string
    job: TJob
    ctx: JobContext
    timeoutMs?: number
  }): Promise<TResult> {
    // Bun.spawn cannot serialize functions across processes; workers needing LLM
    // access must use JOB_SPAWNER=inproc. spawn mode is reserved for future
    // workers doing pure computation. See: lobster-spawn-llm-bridge (planned).
    throw new Error(
      'BunSpawnJobSpawner does not support JobContext.invoke. ' +
      'Workers that need LLM access must use JOB_SPAWNER=inproc (default). ' +
      'See spec: lobster-spawn-llm-bridge (planned).'
    )
  }
}
