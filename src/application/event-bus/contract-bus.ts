// ContractBus — typed wrapper around the raw event bus.
// Single emit surface for all contracted events.
//
// Usage:
//   const bus = asContractBus(ctx.bus)
//   await bus.emit('turn.started', { sessionId, turnId }, { sessionId })

import type { ContractedEventMap, ContractedEventName } from '../contracts/events/contracted-event-map'
import type { EventEnvelope, CreateEventOpts } from '../contracts/event-envelope'
import { createEvent } from '../contracts/event-envelope'

export interface ContractBus {
  /** Typed emit for contracted events. Wraps payload in an EventEnvelope internally. */
  emit<K extends ContractedEventName>(
    type: K,
    payload: ContractedEventMap[K],
    opts?: CreateEventOpts,
  ): Promise<void>
  /** Untyped emit for non-contracted / internal events. */
  emit(type: string, payload: unknown, opts?: CreateEventOpts): Promise<void>

  /** Typed subscribe — handler receives the unwrapped payload. */
  on<K extends ContractedEventName>(
    type: K,
    handler: (payload: ContractedEventMap[K]) => void | Promise<void>,
  ): () => void
  /** Untyped subscribe for non-contracted events. */
  on(type: string, handler: (payload: unknown) => void | Promise<void>): () => void

  /** Emit and collect per-subscriber results. Resolves after all handlers settle. */
  emitWithResults(type: string, payload: unknown): Promise<{ ok: boolean; failures: string[] }>
}

/** Raw bus shape consumed by the wrapper. `on` is optional — only needed for subscriptions. */
export interface RawBus {
  emit(name: string, payload: unknown): Promise<void>
  on?(name: string, handler: (payload: unknown) => void | Promise<void>): () => void
  emitWithResults?(name: string, payload: unknown): Promise<{ ok: boolean; failures: string[] }>
}

/** Wrap a raw event bus to enforce contracted event typing. */
export function asContractBus(bus: RawBus): ContractBus {
  const hasOn = typeof bus.on === 'function'
  return {
    emit(type: string, payload: unknown, opts?: CreateEventOpts): Promise<void> {
      const envelope: EventEnvelope<string, unknown> = createEvent(type, payload, opts)
      return bus.emit(type, envelope)
    },

    on: hasOn
      ? ((type: string, handler: (payload: unknown) => void | Promise<void>): (() => void) => {
          return bus.on!(type, (raw: unknown) => {
            const r = (raw as Record<string, unknown> | undefined) ?? {}
            const isEnvelope =
              typeof r.payload === 'object' && r.payload !== null &&
              typeof r.type === 'string' && typeof r.version === 'number'
            const p = isEnvelope ? r.payload : raw
            void handler(p)
          })
        }) as ContractBus['on']
      : ((_type: string, _handler: (payload: unknown) => void | Promise<void>) => {
          return () => {}
        }) as ContractBus['on'],

    emitWithResults(type: string, payload: unknown): Promise<{ ok: boolean; failures: string[] }> {
      const envelope: EventEnvelope<string, unknown> = createEvent(type, payload)
      if (bus.emitWithResults) return bus.emitWithResults(type, envelope)
      return bus.emit(type, envelope).then(() => ({ ok: true, failures: [] }))
    },
  }
}
