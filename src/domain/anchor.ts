/**
 * Canonical Anchor type — the ONLY way to derive a sessionId.
 *
 * Every adapter that receives external input MUST convert it to an Anchor first,
 * then use anchorToSessionId() to produce the stable, deterministic sessionId.
 *
 * This module is the single source of truth for session identity.
 * No hardcoded string (e.g. 'main') may appear as a sessionId anywhere.
 */

export type Anchor =
  | { kind: 'tui';        frontendId: string }
  | { kind: 'lark-p2p';   appId: string; openId: string }
  | { kind: 'lark-group'; appId: string; chatId: string }

/**
 * Derive a stable, deterministic sessionId from an Anchor.
 * This is the ONLY function that produces sessionIds.
 * All adapters MUST use it rather than string concatenation or hardcoded values.
 */
export function anchorToSessionId(a: Anchor): string {
  switch (a.kind) {
    case 'tui':        return `tui-${a.frontendId}`
    case 'lark-p2p':   return `lark-p2p-${a.appId}-${a.openId}`
    case 'lark-group': return `lark-grp-${a.appId}-${a.chatId}`
  }
}

/**
 * Internal routing key equal to anchorToSessionId.
 * Used by RoutingTable for fast lookup; never exposed across extensions.
 *
 * @see src/application/routing/routing-table.ts
 */
export function anchorKey(a: Anchor): string {
  return anchorToSessionId(a)
}

/**
 * Canonical Main session ID — shared by TUI default frontend and Lark p2p.
 * Centralized here so cross-cutting consumers don't hardcode 'tui-default'.
 */
export const MAIN_SESSION_ID: string = anchorToSessionId({ kind: 'tui', frontendId: 'default' })
