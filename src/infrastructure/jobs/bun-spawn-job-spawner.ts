/// <reference types="bun" />

import type { JobSpawner } from '../../application/ports/job-spawner'

export class BunSpawnJobSpawner implements JobSpawner {
  async run<TJob, TResult>(opts: {
    entry: string
    job: TJob
    ctx: { invoke?: unknown; log?: unknown }
    timeoutMs?: number
  }): Promise<TResult> {
    if (opts.ctx?.invoke) {
      throw new Error(
        'BunSpawnJobSpawner does not support JobContext.invoke. ' +
        'Workers that need LLM access must use JOB_SPAWNER=inproc (default). ' +
        'See spec: lobster-spawn-llm-bridge (planned).'
      )
    }

    const proc = Bun.spawn(['bun', 'run', opts.entry], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'inherit',
      env: { ...process.env, JOB_MODE: 'spawn' },
    })

    const payload = JSON.stringify(opts.job) + '\n'
    const writeResult = proc.stdin.write(payload)
    if (writeResult && typeof (writeResult as Promise<unknown>).then === 'function') {
      await writeResult
    }
    await proc.stdin.end()

    const timer = opts.timeoutMs
      ? setTimeout(() => proc.kill(), opts.timeoutMs)
      : null

    try {
      const text = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      if (exitCode !== 0) throw new Error(`worker exit ${exitCode}`)
      const lastLine = text.trim().split('\n').pop()!
      return JSON.parse(lastLine) as TResult
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
