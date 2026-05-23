// MemoryEntry entity — typed memory record with weight, decay, and hit tracking.
// Zero IO dependencies. Zero framework imports.

type MemoryType = 'general' | 'user_preference' | 'project_rule' | 'agent_md'

interface MemoryEntry {
  readonly id: string
  readonly type: MemoryType
  text: string
  weight: number
  source: 'explicit' | 'implicit' | 'user'
  tags: string[]
  createdAt: Date
  updatedAt: Date
  lastHitAt?: Date
  usageCount: number
  embedding?: number[]
}

const MEMORY_DEFAULT_DECAY = 0.95

function clampWeight(w: number): number {
  return Math.max(0, Math.min(1, w))
}

function createMemoryEntry(opts: {
  id: string
  type: MemoryType
  text: string
  weight?: number
  source?: 'explicit' | 'implicit' | 'user'
  tags?: string[]
}): MemoryEntry {
  const weight = clampWeight(opts.weight ?? 1.0)
  const now = new Date()

  return {
    id: opts.id,
    type: opts.type,
    text: opts.text,
    weight,
    source: opts.source ?? 'explicit',
    tags: opts.tags ?? [],
    createdAt: now,
    updatedAt: now,
    lastHitAt: undefined,
    usageCount: 0,
    embedding: undefined,
  }
}

function markHit(entry: MemoryEntry): void {
  entry.usageCount += 1
  entry.lastHitAt = new Date()
}

function decayWeight(entry: MemoryEntry, factor?: number): void {
  entry.weight = clampWeight(entry.weight * (factor ?? MEMORY_DEFAULT_DECAY))
}

export { createMemoryEntry, markHit, decayWeight }
export type { MemoryEntry, MemoryType }
