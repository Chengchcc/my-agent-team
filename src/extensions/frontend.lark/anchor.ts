// Re-export canonical Anchor from domain — single source of truth (PR G3).
import type { Anchor } from '../../domain/anchor'
export type { Anchor }
export { anchorToSessionId, anchorKey } from '../../domain/anchor'

// Legacy-compat types for internal use during migration.
// AnchorScope and RoutingEntry are kept here for the RoutingContext type
// which uses Anchor directly now.

type AnchorScope = 'thread' | 'chat' | 'p2p' | 'tui'

interface RoutingEntry {
  appId: string
  anchor: Anchor
  sessionId: string
  label?: string
}

export type { AnchorScope, RoutingEntry }
