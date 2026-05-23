import { describe, it, expect } from 'bun:test'
import { defineExtension } from '../../src/kernel/define-extension'
import {
  topoSort,
  CircularDependencyError,
  DependencyNotFoundError,
} from '../../src/kernel/topo-sort'

describe('topoSort', () => {
  // --- helpers ---
  function makeExt(
    name: string,
    opts?: { enforce?: 'pre' | 'normal' | 'post'; dependsOn?: string[] },
  ) {
    return defineExtension({
      name,
      enforce: opts?.enforce,
      dependsOn: opts?.dependsOn,
      apply: () => ({}),
    })
  }

  function namesOf(exts: ReturnType<typeof makeExt>[]) {
    return exts.map((e) => e.name)
  }

  // 1. Empty array
  it('returns empty for empty array', () => {
    expect(topoSort([])).toEqual([])
  })

  // 2. Single extension
  it('returns same for single extension', () => {
    const ext = makeExt('a')
    expect(namesOf(topoSort([ext]))).toEqual(['a'])
  })

  // 3. No dependencies, different enforce
  it('sorts by enforce: pre before normal before post', () => {
    const pre = makeExt('pre-ext', { enforce: 'pre' })
    const normal = makeExt('normal-ext', { enforce: 'normal' })
    const post = makeExt('post-ext', { enforce: 'post' })
    // Input out of order
    const sorted = topoSort([post, normal, pre])
    expect(namesOf(sorted)).toEqual(['pre-ext', 'normal-ext', 'post-ext'])
  })

  // 4. Same enforce, different names
  it('sorts lexicographically within same enforce', () => {
    const c = makeExt('c', { enforce: 'normal' })
    const a = makeExt('a', { enforce: 'normal' })
    const b = makeExt('b', { enforce: 'normal' })
    const sorted = topoSort([c, a, b])
    expect(namesOf(sorted)).toEqual(['a', 'b', 'c'])
  })

  // 5. Linear dependency chain: C -> B -> A
  it('sorts linear dependency chain C->B->A', () => {
    const a = makeExt('a', { enforce: 'normal' })
    const b = makeExt('b', { enforce: 'normal', dependsOn: ['a'] })
    const c = makeExt('c', { enforce: 'normal', dependsOn: ['b'] })
    // Input in reverse order
    const sorted = topoSort([c, b, a])
    expect(namesOf(sorted)).toEqual(['a', 'b', 'c'])
  })

  // 6. Diamond dependency: D depends on B and C, B and C both depend on A
  it('sorts diamond dependency: A before B/C before D', () => {
    const a = makeExt('a', { enforce: 'normal' })
    const b = makeExt('b', { enforce: 'normal', dependsOn: ['a'] })
    const c = makeExt('c', { enforce: 'normal', dependsOn: ['a'] })
    const d = makeExt('d', { enforce: 'normal', dependsOn: ['b', 'c'] })
    const sorted = topoSort([d, c, b, a])
    const names = namesOf(sorted)
    // A must come first
    expect(names[0]).toBe('a')
    // B and C come before D
    const bIdx = names.indexOf('b')
    const cIdx = names.indexOf('c')
    const dIdx = names.indexOf('d')
    expect(bIdx).toBeLessThan(dIdx)
    expect(cIdx).toBeLessThan(dIdx)
  })

  // 7. Mixed enforce + deps: pre depends on normal
  it('places pre extension after its normal dependency', () => {
    const normal = makeExt('normal-ext', { enforce: 'normal' })
    const pre = makeExt('pre-ext', { enforce: 'pre', dependsOn: ['normal-ext'] })
    const sorted = topoSort([pre, normal])
    const names = namesOf(sorted)
    // Topological ordering is primary: normal-ext must come before pre-ext
    expect(names.indexOf('normal-ext')).toBeLessThan(names.indexOf('pre-ext'))
  })

  // 8. Circular dependency
  it('throws CircularDependencyError on circular dependency', () => {
    const a = makeExt('a', { dependsOn: ['b'] })
    const b = makeExt('b', { dependsOn: ['a'] })
    expect(() => topoSort([a, b])).toThrow(CircularDependencyError)
  })

  it('throws CircularDependencyError on 3-way cycle', () => {
    const a = makeExt('a', { dependsOn: ['c'] })
    const b = makeExt('b', { dependsOn: ['a'] })
    const c = makeExt('c', { dependsOn: ['b'] })
    try {
      topoSort([a, b, c])
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(CircularDependencyError)
      const err = e as CircularDependencyError
      expect(err.cycle).toBeArray()
      expect(err.cycle.length).toBeGreaterThan(0)
    }
  })

  // 9. Missing dependency
  it('throws DependencyNotFoundError on missing dependency', () => {
    const a = makeExt('a', { dependsOn: ['nonexistent'] })
    expect(() => topoSort([a])).toThrow(DependencyNotFoundError)
  })

  // 10. PRD example
  it('sorts the PRD example correctly', () => {
    const trace = makeExt('trace', { enforce: 'pre' })
    const session = makeExt('session', { enforce: 'normal', dependsOn: ['trace'] })
    const memory = makeExt('memory', {
      enforce: 'normal',
      dependsOn: ['trace'],
    })
    const provider = makeExt('provider', { enforce: 'normal' })
    const controlplane = makeExt('controlplane', { enforce: 'post' })

    // Scramble input order
    const sorted = topoSort([controlplane, memory, provider, session, trace])
    const names = namesOf(sorted)

    // trace (pre, layer 0) must be first
    expect(names[0]).toBe('trace')
    // Topological layers dominate: layer 0 items come before layer 1 items.
    // Layer 0: trace(pre), provider(normal), controlplane(post) -- sorted by enforce
    // Layer 1: memory(normal), session(normal) -- sorted by name
    // So full order: trace, provider, controlplane, memory, session
    expect(names).toEqual(['trace', 'provider', 'controlplane', 'memory', 'session'])
    // memory and session depend on trace, so trace must come before them
    expect(names.indexOf('trace')).toBeLessThan(names.indexOf('memory'))
    expect(names.indexOf('trace')).toBeLessThan(names.indexOf('session'))
  })
})
