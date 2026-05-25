import type { ExtensionBuilder, Enforce } from './define-extension'

/**
 * Sort key = (kahnLayer, enforceWeight, name)
 * Lower = earlier in execution order
 */
interface SortKey {
  kahnLayer: number
  enforceWeight: number
  name: string
}

const ENFORCE_WEIGHT: Record<Enforce, number> = {
  guard: 0,
  pre: 1,
  normal: 2,
  post: 3,
}

/**
 * Sort extensions by:
 * 1. Topological layer (dependsOn -> must come before dependents)
 * 2. enforce (pre -> normal -> post)
 * 3. Name (lexicographic, stable tiebreaker)
 *
 * Throws CircularDependencyError if circular deps detected.
 */
function topoSort(extensions: ExtensionBuilder[]): ExtensionBuilder[] {
  if (extensions.length === 0) return []

  // Build name -> index map
  const nameToIndex = new Map<string, number>()
  extensions.forEach((ext, i) => nameToIndex.set(ext.name, i))

  // Build adjacency: depender -> list of dependents (edges: from -> to)
  // If A dependsOn B, then B must come before A
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>() // ext -> who depends on it

  for (const ext of extensions) {
    if (!inDegree.has(ext.name)) {
      inDegree.set(ext.name, 0)
    }
    for (const dep of ext.dependsOn) {
      if (!nameToIndex.has(dep)) {
        throw new DependencyNotFoundError(ext.name, dep)
      }
      inDegree.set(ext.name, (inDegree.get(ext.name) ?? 0) + 1)
      if (!dependents.has(dep)) {
        dependents.set(dep, [])
      }
      dependents.get(dep)!.push(ext.name)
    }
  }

  // Kahn's algorithm -- BFS by layer
  const queue: string[] = []
  const layerMap = new Map<string, number>()

  for (const [name, degree] of inDegree) {
    if (degree === 0) {
      queue.push(name)
      layerMap.set(name, 0)
    }
  }

  let processed = 0
  while (queue.length > 0) {
    const current = queue.shift()!
    const currentLayer = layerMap.get(current)!
    processed++

    for (const dep of dependents.get(current) ?? []) {
      const newDegree = (inDegree.get(dep) ?? 1) - 1
      inDegree.set(dep, newDegree)
      if (newDegree === 0) {
        queue.push(dep)
        layerMap.set(dep, currentLayer + 1)
      }
    }
  }

  if (processed !== extensions.length) {
    // Find the cycle participants
    const remaining = extensions.filter((e) => inDegree.get(e.name)! > 0)
    throw new CircularDependencyError(remaining.map((e) => e.name))
  }

  // Sort by (kahnLayer, enforceWeight, name)
  return [...extensions].sort((a, b) => {
    const keyA: SortKey = {
      kahnLayer: layerMap.get(a.name) ?? 0,
      enforceWeight: ENFORCE_WEIGHT[a.enforce],
      name: a.name,
    }
    const keyB: SortKey = {
      kahnLayer: layerMap.get(b.name) ?? 0,
      enforceWeight: ENFORCE_WEIGHT[b.enforce],
      name: b.name,
    }
    if (keyA.kahnLayer !== keyB.kahnLayer) return keyA.kahnLayer - keyB.kahnLayer
    if (keyA.enforceWeight !== keyB.enforceWeight)
      return keyA.enforceWeight - keyB.enforceWeight
    return keyA.name.localeCompare(keyB.name)
  })
}

class CircularDependencyError extends Error {
  readonly cycle: string[]
  constructor(cycle: string[]) {
    super(`Circular dependency detected: ${cycle.join(' -> ')}`)
    this.name = 'CircularDependencyError'
    this.cycle = cycle
  }
}

class DependencyNotFoundError extends Error {
  constructor(extName: string, missingDep: string) {
    super(
      `Extension "${extName}" depends on "${missingDep}" which is not registered`,
    )
    this.name = 'DependencyNotFoundError'
  }
}

export { topoSort, CircularDependencyError, DependencyNotFoundError }
export type { SortKey }
