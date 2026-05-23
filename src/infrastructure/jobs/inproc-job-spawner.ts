import type { JobSpawner } from '../../application/ports/job-spawner'

export class InprocJobSpawner implements JobSpawner {
  async run<TJob, TResult>(opts: {
    entry: string
    job: TJob
    timeoutMs?: number
  }): Promise<TResult> {
    const mod = await import(opts.entry)
    if (typeof mod.handle !== 'function') {
      throw new Error(`${opts.entry} missing exported handle()`)
    }
    return await mod.handle(opts.job) as TResult
  }
}
