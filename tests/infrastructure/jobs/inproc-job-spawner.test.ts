import { describe, it, expect } from 'bun:test'
import { InprocJobSpawner } from '../../../src/infrastructure/jobs/inproc-job-spawner'
import { join } from 'path'

describe('InprocJobSpawner', () => {
  it('calls handle and returns result', async () => {
    const spawner = new InprocJobSpawner()
    const result = await spawner.run<{ name: string }, { greeting: string }>({
      entry: join(import.meta.dir, '..', '..', 'fixtures', 'hello-worker.ts'),
      job: { name: 'World' },
    })
    expect(result).toEqual({ greeting: 'Hello, World!' })
  })

  it('rejects when entry has no handle export', async () => {
    const spawner = new InprocJobSpawner()
    await expect(
      spawner.run({
        entry: join(import.meta.dir, '..', '..', 'fixtures', 'no-handle.ts'),
        job: {},
      }),
    ).rejects.toThrow('missing exported handle')
  })
})
