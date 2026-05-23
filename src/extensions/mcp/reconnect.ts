import type { McpServerConfig } from '../../config/types'
import type { McpClientEntry } from './types'
import type { Logger } from '../../application/ports/logger'

const JITTER_MIN_FACTOR = 0.75
const JITTER_RANGE_FACTOR = 0.5

export interface ReconnectContext {
  servers: Map<string, McpClientEntry>
  attempts: Map<string, number>
  maxReconnectAttempts: number
  reconnectDelayMs: number
  logger?: Logger
  connectServer: (config: McpServerConfig) => Promise<void>
}

/** Auto-reconnect after unexpected disconnection with jitter and max retry limit. */
export async function runReconnect(ctx: ReconnectContext, serverName: string): Promise<void> {
  const entry = ctx.servers.get(serverName)
  if (!entry) return

  const maxAttempts = ctx.maxReconnectAttempts
  const baseDelay = ctx.reconnectDelayMs
  const currentAttempt = ctx.attempts.get(serverName) ?? 0

  for (let attempt = currentAttempt + 1; attempt <= maxAttempts; attempt++) {
    ctx.attempts.set(serverName, attempt)
    ctx.logger?.debug('mcp', `[McpManager] Reconnecting '${serverName}' attempt ${attempt}/${maxAttempts}`)

    try {
      ctx.servers.delete(serverName)
      await ctx.connectServer(entry.config)
      ctx.attempts.delete(serverName)
      ctx.logger?.debug('mcp', `[McpManager] '${serverName}' reconnected successfully`)
      return
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      ctx.logger?.debug('mcp', `[McpManager] '${serverName}' reconnect attempt ${attempt} failed: ${msg}`)

      if (attempt < maxAttempts) {
        const base = baseDelay * Math.pow(2, attempt - 1)
        const jitter = base * (JITTER_MIN_FACTOR + Math.random() * JITTER_RANGE_FACTOR)
        await new Promise(resolve => setTimeout(resolve, jitter))
      }
    }
  }

  // All attempts exhausted
  ctx.attempts.delete(serverName)
  ctx.servers.set(serverName, {
    config: entry.config,
    client: null,
    transport: null,
    state: {
      status: 'exhausted',
      message: `Reconnect failed after ${maxAttempts} attempts`,
      since: Date.now(),
    },
  })
  ctx.logger?.debug('mcp', `[McpManager] '${serverName}' reconnect exhausted after ${maxAttempts} attempts`)
}
