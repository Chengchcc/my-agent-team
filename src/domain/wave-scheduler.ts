import type { ToolCall } from './turn-runner.types'

export interface ToolConflictMeta {
  readonly?: boolean
  conflictKey?: (input: unknown) => string | null
}

/**
 * Partition tool calls into waves by conflictKey.
 * Calls within a wave have no conflicts; waves run sequentially.
 *
 * Pure function — no I/O, no side effects.
 */
export function partitionWaves(
  calls: ReadonlyArray<ToolCall>,
  descriptors: ReadonlyMap<string, ToolConflictMeta>,
): ToolCall[][] {
  if (calls.length === 0) return []

  let remaining = [...calls]
  const waves: ToolCall[][] = []

  while (remaining.length > 0) {
    const wave: ToolCall[] = []
    const takenKeys = new Set<string>()
    const next: ToolCall[] = []

    for (const c of remaining) {
      const meta = descriptors.get(c.name)
      if (meta?.readonly) {
        wave.push(c)
        continue
      }

      const key = resolveConflictKey(c, meta)

      if (!takenKeys.has(key)) {
        wave.push(c)
        takenKeys.add(key)
      } else {
        next.push(c)
      }
    }

    waves.push(wave)
    remaining = next
  }

  return waves
}

function resolveConflictKey(call: ToolCall, meta?: ToolConflictMeta): string {
  if (!meta?.conflictKey) return `tool:${call.name}`
  try {
    const key = meta.conflictKey(call.arguments)
    return key != null ? key : `tool:${call.name}`
  } catch {
    return `tool:${call.name}`
  }
}
