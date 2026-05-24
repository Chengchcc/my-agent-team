import { describe, it, expect } from 'bun:test'
import type { ToolCall } from '../../src/domain/turn-runner.types'

/**
 * RED phase — partitionWaves doesn't exist yet.
 * Tests will fail until domain/wave-scheduler.ts is implemented.
 */
import { partitionWaves } from '../../src/domain/wave-scheduler'

// ── helpers ──

function call(name: string, overrides?: Partial<ToolCall>): ToolCall {
  return { id: `${name}-1`, name, arguments: {}, ...overrides }
}

interface ToolMeta {
  readonly?: boolean
  conflictKey?: (input: unknown) => string | null
}

function desc(readonly?: boolean, conflictKey?: () => string | null): ToolMeta {
  return { readonly, conflictKey }
}

function descKey(conflictKey: () => string | null): ToolMeta {
  return { conflictKey }
}

function descRo(): ToolMeta {
  return { readonly: true }
}

function descriptors(map: Record<string, ToolMeta>): Map<string, ToolMeta> {
  return new Map(Object.entries(map))
}

function flat(waves: ToolCall[][]): ToolCall[] {
  return waves.flat()
}

// ── tests ──

describe('partitionWaves', () => {
  // ── Invariant 1: flatten(waves) === C, order preserved ──

  it('preserves order (invariant 1)', () => {
    const calls = [call('read'), call('bash'), call('read'), call('write')]
    const descs = descriptors({
      read: descRo(),
      bash: descKey(() => 'bash:global'),
      write: descKey(() => 'file:/x'),
    })
    const waves = partitionWaves(calls, descs)
    expect(flat(waves)).toEqual(calls)
  })

  // ── Invariant 2: same wave non-readonly calls have distinct conflictKey ──

  it('no two non-readonly calls in a wave share conflictKey (invariant 2)', () => {
    const calls = [call('bash'), call('write', { id: 'w1' }), call('write', { id: 'w2' })]
    const descs = descriptors({
      bash: descKey(() => 'bash:global'),
      write: descKey(() => 'file:/x'),
    })
    const waves = partitionWaves(calls, descs)
    for (const wave of waves) {
      const keys = wave
        .filter(c => !descs.get(c.name)?.readonly)
        .map(c => {
          const d = descs.get(c.name)
          return d?.conflictKey?.(c.arguments) ?? `tool:${c.name}`
        })
      expect(new Set(keys).size).toBe(keys.length)
    }
  })

  // ── Invariant 3: cross-wave same conflictKey → sequential ──

  it('same conflictKey calls are in different waves (invariant 3)', () => {
    const calls = [call('write', { id: 'w1' }), call('write', { id: 'w2' })]
    const descs = descriptors({ write: descKey(() => 'file:/x') })
    const waves = partitionWaves(calls, descs)
    expect(waves).toHaveLength(2)
    expect(waves[0]).toHaveLength(1)
    expect(waves[1]).toHaveLength(1)
  })

  // ── Invariant 4: wave 数 ≤ N, wave 数 = max(同 conflictKey 出现次数) ──

  it('wave count ≤ call count, equals max same-key occurrences (invariant 4)', () => {
    const calls = [
      call('write', { id: 'w1' }), call('write', { id: 'w2' }),
      call('bash', { id: 'b1' }), call('write', { id: 'w3' }),
    ]
    const descs = descriptors({
      write: descKey(() => 'file:/x'),
      bash: descKey(() => 'bash:global'),
    })
    const waves = partitionWaves(calls, descs)
    expect(waves.length).toBeLessThanOrEqual(calls.length)
    // max occurrence: write appears 3 times → should be 3 waves
    expect(waves.length).toBe(3)
  })

  // ── Invariant 5: all readonly → 1 wave, N concurrent ──

  it('all readonly N calls → 1 wave (invariant 5)', () => {
    const calls = [call('read'), call('grep'), call('glob'), call('ls')]
    const descs = descriptors({
      read: descRo(), grep: descRo(), glob: descRo(), ls: descRo(),
    })
    const waves = partitionWaves(calls, descs)
    expect(waves).toHaveLength(1)
    expect(waves[0]).toHaveLength(4)
  })

  // ── Invariant 6: all same conflictKey → N waves, fully serial ──

  it('all same conflictKey N calls → N waves (invariant 6)', () => {
    const calls = Array.from({ length: 5 }, (_, i) => call('bash', { id: `b${i}` }))
    const descs = descriptors({ bash: descKey(() => 'bash:global') })
    const waves = partitionWaves(calls, descs)
    expect(waves).toHaveLength(5)
    for (const wave of waves) expect(wave).toHaveLength(1)
  })

  // ── Mixed readonly + mutable sharing conflictKey ──

  it('mixed: readonly calls pack into early waves with non-conflicting mutable calls', () => {
    // read is readonly, write/a and write/b share file:/x, bash is bash:global
    const calls = [
      call('read', { id: 'r1' }),
      call('write', { id: 'w1' }),  // file:/x
      call('read', { id: 'r2' }),
      call('write', { id: 'w2' }),  // file:/x — conflicts with w1
      call('bash', { id: 'b1' }),   // bash:global
    ]
    const descs = descriptors({
      read: descRo(),
      write: descKey(() => 'file:/x'),
      bash: descKey(() => 'bash:global'),
    })
    const waves = partitionWaves(calls, descs)
    // wave1: [r1, w1, r2, bash] — all distinct non-ro keys
    // wave2: [w2] — conflicts with w1
    expect(waves).toHaveLength(2)
    expect(waves[0]!.length).toBe(4)
    expect(waves[0]!.map(c => c.id)).toEqual(['r1', 'w1', 'r2', 'b1'])
    expect(waves[1]!.length).toBe(1)
    expect(waves[1]![0]!.id).toBe('w2')
  })

  // ── conflictKey fallback on throw (invariant 12) ──

  it('conflictKey that throws → fallback to tool:<name> (invariant 12)', () => {
    const badKey = () => { throw new Error('bad') }
    const calls = [call('buggy', { id: 'bg1' }), call('buggy', { id: 'bg2' })]
    const descs = descriptors({ buggy: descKey(badKey) })
    // Both fall back to 'tool:buggy' → same key → 2 waves
    const waves = partitionWaves(calls, descs)
    expect(waves).toHaveLength(2)
  })

  // ── conflictKey same input same output ──

  it('conflictKey same input returns same key (stability)', () => {
    let callCount = 0
    const counter = (input: unknown) => { callCount++; return `file:${(input as Record<string, string>).path}` }
    const descs = descriptors({ edit: descKey(counter) })
    const a = call('edit', { id: 'a', arguments: { path: '/a' } })
    const b = call('edit', { id: 'b', arguments: { path: '/a' } })
    const waves = partitionWaves([a, b], descs)
    // Same path → same conflictKey → 2 waves
    expect(waves).toHaveLength(2)
  })

  // ── Empty calls → no waves ──

  it('empty calls returns empty array', () => {
    const waves = partitionWaves([], new Map())
    expect(waves).toEqual([])
  })

  // ── Single call → single wave ──

  it('single call produces single wave', () => {
    const waves = partitionWaves(
      [call('bash')],
      descriptors({ bash: descKey(() => 'bash:global') }),
    )
    expect(waves).toEqual([[call('bash')]])
  })

  // ── Unknown tool (no descriptor) → default conflictKey 'tool:<name>' ──

  it('unknown tool (no descriptor) defaults to tool:<name> conflictKey', () => {
    const calls = [call('unknown', { id: 'u1' }), call('unknown', { id: 'u2' })]
    const waves = partitionWaves(calls, new Map())
    // Both default to 'tool:unknown' → same key → 2 waves
    expect(waves).toHaveLength(2)
  })

  // ── Descriptor without conflictKey → default 'tool:<name>' ──

  it('descriptor without conflictKey defaults to tool:<name>', () => {
    const calls = [call('ask'), call('ask')]
    const descs = descriptors({ ask: {} }) // no readonly, no conflictKey
    const waves = partitionWaves(calls, descs)
    // Both default to 'tool:ask' → 2 waves
    expect(waves).toHaveLength(2)
  })
})
