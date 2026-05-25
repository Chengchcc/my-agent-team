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

    const errors: Array<{ error: Error; payloadSample: unknown }> = []
    await Promise.all(
      [...handlers].map(async (handler) => {
        try {
          await handler(payload)
        } catch (err) {
          errors.push({ error: err instanceof Error ? err : new Error(String(err)), payloadSample: payload })
        }
      })
    )

    if (errors.length > 0) {
      for (const { error, payloadSample } of errors) {
        const payloadType = typeof payloadSample
        const payloadKeys = payloadSample && typeof payloadSample === 'object' && !Array.isArray(payloadSample)
          ? Object.keys(payloadSample as Record<string, unknown>).slice(0, 10)
          : undefined
        const msg = `[EventBus] subscriber error on "${event}": ${error.message} | payloadType=${payloadType}${payloadKeys ? ` keys=${payloadKeys.join(',')}` : ''}`
        if (this.logger) {
          this.logger.warn('event-bus', msg)
        } else {
          console.warn(msg)
        }
      }
    }
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
