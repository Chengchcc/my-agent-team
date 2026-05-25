// ── spawn.worker.started ─────────────────────────────────────────────────────

export interface SpawnWorkerStartedV1 {
  jobType: string
  pid: number
}

// ── spawn.worker.invoke ──────────────────────────────────────────────────────

export interface SpawnWorkerInvokeV1 {
  jobType: string
  pid: number
  purpose: string
  latencyMs: number
}

// ── spawn.worker.exited ──────────────────────────────────────────────────────

export interface SpawnWorkerExitedV1 {
  jobType: string
  pid: number
  code: number | null
  durationMs: number
}

// ── spawn.worker.killed ──────────────────────────────────────────────────────

export interface SpawnWorkerKilledV1 {
  jobType: string
  pid: number
  reason: string
}
