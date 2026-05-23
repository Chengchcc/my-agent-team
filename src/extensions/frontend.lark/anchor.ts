type AnchorScope = 'thread' | 'chat' | 'p2p' | 'tui'

interface Anchor {
  scope: AnchorScope
  key: string // threadId, chatId, userId, or 'tui-main'
}

interface RoutingEntry {
  appId: string
  anchor: Anchor
  sessionId: string
  label?: string
}

export type { AnchorScope, Anchor, RoutingEntry }
