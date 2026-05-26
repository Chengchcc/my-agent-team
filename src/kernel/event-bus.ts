import type { Logger } from '../application/ports/logger'

type EventHandler = (payload: unknown) => void | Promise<void>

/**
 * Pub/sub event broker with topic strings and async subscribers.
 * Failure isolation: one subscriber failing does not affect others.
 */
class EventBus {
  private subscribers = new Map<string, Set<EventHandler>>()
  private logger: Logger | null = null

  constructor(logger?: Logger) {
    this.logger = logger ?? null
  }

  setLogger(logger: Logger): void {
    this.logger = logger
  }

  /**
   * Subscribe to an event. Returns unsubscribe function.
   */
  on(event: string, handler: EventHandler): () => void {
    if (!this.subscribers.has(event)) {
      this.subscribers.set(event, new Set())
    }
    this.subscribers.get(event)!.add(handler)
    return () => {
      this.subscribers.get(event)?.delete(handler)
    }
  }

  /**
   * Emit an event to all subscribers. Failures are isolated — one
   * subscriber rejecting does not affect others. Errors are collected
   * and logged with diagnostic context (payload type, keys) but do not propagate.
   */
  async emit(event: string, payload: unknown): Promise<void> {
    const handlers = this.subscribers.get(event)
    if (!handlers || handlers.size === 0) return

    const isTurnEvent = event.startsWith('turn.')
    const errors: Array<{ error: Error; subscriberName: string; payloadKeys?: string[] }> = []
    await Promise.all(
      [...handlers].map(async (handler, idx) => {
        try {
          await handler(payload)
        } catch (err) {
          const subscriberName = handler.name ? `handler#${idx}(${handler.name})` : `handler#${idx}`
          if (isTurnEvent) {
            // Redact sensitive payload values for turn.* events — log only keys
            const payloadKeys = payload && typeof payload === 'object' && !Array.isArray(payload)
              ? Object.keys(payload as Record<string, unknown>).slice(0, 10)
              : undefined
            errors.push({ error: err instanceof Error ? err : new Error(String(err)), subscriberName, payloadKeys })
          } else {
            const payloadKeys = payload && typeof payload === 'object' && !Array.isArray(payload)
              ? Object.keys(payload as Record<string, unknown>).slice(0, 10)
              : undefined
            errors.push({ error: err instanceof Error ? err : new Error(String(err)), subscriberName, payloadKeys })
          }
        }
      })
    )

    if (errors.length > 0) {
      for (const { error, subscriberName, payloadKeys } of errors) {
        const msg = `[EventBus] subscriber error on "${event}" (${subscriberName}): ${error.message}${payloadKeys ? ` | keys=${payloadKeys.join(',')}` : ''}`
        if (this.logger) {
          this.logger.warn('event-bus', msg)
        } else {
          console.warn(msg)
        }
      }
    }
  }

  /**
   * Emit an event and collect per-subscriber results.
   * Resolves after all handlers settle. Returns { ok, failures }
   * where `ok` is true when all subscribers succeeded.
   */
  async emitWithResults(event: string, payload: unknown): Promise<{ ok: boolean; failures: string[] }> {
    const handlers = this.subscribers.get(event)
    if (!handlers || handlers.size === 0) return { ok: true, failures: [] }

    const failures: string[] = []
    await Promise.all(
      [...handlers].map(async (handler, idx) => {
        try {
          await handler(payload)
        } catch (err) {
          const subscriberName = handler.name ? `handler#${idx}(${handler.name})` : `handler#${idx}`
          const msg = err instanceof Error ? err.message : String(err)
          failures.push(`${subscriberName}: ${msg}`)
          if (this.logger) {
            this.logger.warn('event-bus', `[emitWithResults] subscriber error on "${event}" (${subscriberName}): ${msg}`)
          } else {
            console.warn(`[EventBus] subscriber error on "${event}" (${subscriberName}): ${msg}`)
          }
        }
      })
    )

    return { ok: failures.length === 0, failures }
  }

  /**
   * Remove all subscribers for an event, or all events if no event specified.
   */
  clear(event?: string): void {
    if (event) {
      this.subscribers.delete(event)
    } else {
      this.subscribers.clear()
    }
  }

  /**
   * Get number of subscribers for an event.
   */
  subscriberCount(event: string): number {
    return this.subscribers.get(event)?.size ?? 0
  }
}

export { EventBus }
export type { EventHandler }
