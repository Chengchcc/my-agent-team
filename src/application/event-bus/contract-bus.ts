// ContractBus — typed wrapper around the raw event bus.
// Ensures contracted event emits use createEvent() with correct payload types.

import type { ContractedEventMap, ContractedEventName } from '../contracts/events/contracted-event-map'
import type { EventEnvelope } from '../contracts/event-envelope'

export interface ContractBus {
  emit<K extends ContractedEventName>(
    event: EventEnvelope<K, ContractedEventMap[K]>
  ): Promise<void>
}

/** Wrap a raw event bus to enforce contracted event typing. */
export function asContractBus(bus: { emit(name: string, payload: unknown): Promise<void> }): ContractBus {
  return {
    emit(event) {
      return bus.emit(event.type, event)
    },
  }
}
