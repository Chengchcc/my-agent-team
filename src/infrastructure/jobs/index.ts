import type { JobSpawner } from '../../application/ports/job-spawner'
import { BunSpawnJobSpawner } from './bun-spawn-job-spawner'
import { InprocJobSpawner } from './inproc-job-spawner'

export function createJobSpawner(): JobSpawner {
  const mode = process.env.JOB_SPAWNER ?? 'spawn'
  return mode === 'spawn' ? new BunSpawnJobSpawner() : new InprocJobSpawner()
}
