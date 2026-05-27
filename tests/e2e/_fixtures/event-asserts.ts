import type { EventEnvelope } from '../../../src/application/contracts/event-envelope'

/** Concatenate all llm.delta text for a session (raw bus event type). */
export function assistantText(buf: EventEnvelope[], sid: string): string {
  return buf
    .filter(e => e.type === 'llm.delta' && e.sessionId === sid)
    .map(e => {
      const p = (e.payload as Record<string, unknown> | undefined) ?? {}
      // ContractBus envelope: payload is wrapped; raw: payload is the event
      const inner = (p.payload ?? p) as { delta?: string }
      return inner.delta ?? ''
    }).join('')
}

/** Count turn.completed + turn.failed for a session. */
export function terminalCount(buf: EventEnvelope[], sid: string): number {
  return buf.filter(e =>
    (e.type === 'turn.completed' || e.type === 'turn.failed') && e.sessionId === sid
  ).length
}

/** Find per-session events missing sessionId on the envelope. */
export function eventsWithoutSessionId(buf: EventEnvelope[], typePrefix: string): EventEnvelope[] {
  return buf.filter(e => e.type.startsWith(typePrefix) && !e.sessionId)
}

/** Filter captured events after a given index. */
export function eventsAfter(buf: EventEnvelope[], cursor: number, pred: (e: EventEnvelope) => boolean): EventEnvelope[] {
  return buf.slice(cursor).filter(pred)
}
