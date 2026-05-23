import type { RoutingEntry, Anchor } from './anchor'

class RoutingTable {
  private entries = new Map<string, RoutingEntry>() // key: `${appId}:${scope}:${key}`

  private makeKey(appId: string, scope: string, key: string): string {
    return `${appId}:${scope}:${key}`
  }

  /** Route an anchor to a session. Returns sessionId, or null if no mapping exists. */
  resolve(appId: string, anchor: Anchor): string | null {
    return (
      this.entries.get(this.makeKey(appId, anchor.scope, anchor.key))
        ?.sessionId ?? null
    )
  }

  /** Create or update a routing entry */
  bind(
    appId: string,
    anchor: Anchor,
    sessionId: string,
    label?: string,
  ): RoutingEntry {
    const entry: RoutingEntry = { appId, anchor, sessionId }
    if (label !== undefined) {
      entry.label = label
    }
    this.entries.set(this.makeKey(appId, anchor.scope, anchor.key), entry)
    return entry
  }

  /** Remove a routing entry */
  unbind(appId: string, anchor: Anchor): boolean {
    return this.entries.delete(this.makeKey(appId, anchor.scope, anchor.key))
  }

  /** List all entries for a bot */
  listByBot(appId: string): RoutingEntry[] {
    return [...this.entries.values()].filter((e) => e.appId === appId)
  }

  /** List all entries */
  listAll(): RoutingEntry[] {
    return [...this.entries.values()]
  }

  /** INVARIANT: same (appId, scope, key) maps to exactly 1 sessionId */
  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}

export { RoutingTable }
