import type { Anchor } from '../../domain/anchor'
import { anchorKey } from '../../domain/anchor'

export interface RoutingEntry {
  appId: string
  anchor: Anchor
  sessionId: string
  label?: string
}

/**
 * Shared RoutingTable — owns the N:1 mapping from anchor to sessionId.
 *
 * Internal key is `appId:anchorKey(anchor)`, which guarantees that for a given
 * (appId, anchor) there is exactly 0 or 1 sessionId.
 *
 * Moved from src/extensions/frontend.lark/routing-table.ts to become a
 * first-class application concept (PR G3).
 */
export class RoutingTable {
  private entries = new Map<string, RoutingEntry>()

  private makeKey(appId: string, anchor: Anchor): string {
    return `${appId}:${anchorKey(anchor)}`
  }

  /** Look up the sessionId bound to an anchor, or null if none. */
  lookup(appId: string, anchor: Anchor): string | null {
    return this.entries.get(this.makeKey(appId, anchor))?.sessionId ?? null
  }

  /** Create or update a routing entry. */
  bind(appId: string, anchor: Anchor, sessionId: string, label?: string): RoutingEntry {
    const entry: RoutingEntry = { appId, anchor, sessionId }
    if (label !== undefined) entry.label = label
    this.entries.set(this.makeKey(appId, anchor), entry)
    return entry
  }

  /** Remove a routing entry. */
  unbind(appId: string, anchor: Anchor): boolean {
    return this.entries.delete(this.makeKey(appId, anchor))
  }

  /** List all entries for a bot. */
  listByBot(appId: string): RoutingEntry[] {
    return [...this.entries.values()].filter((e) => e.appId === appId)
  }

  /** List all entries. */
  listAll(): RoutingEntry[] {
    return [...this.entries.values()]
  }

  /** Number of entries. */
  get size(): number {
    return this.entries.size
  }

  /** Clear all entries. */
  clear(): void {
    this.entries.clear()
  }
}
