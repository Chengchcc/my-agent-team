// TraceEvent entity — monotonically-cursored event with ULID identity.
// Zero IO dependencies. Uses ULID generator from shared.
import { generateULID } from '../shared/ulid'

type TraceEventType =
  | 'turn.started'
  | 'turn.completed'
  | 'turn.failed'
  | 'tool.call'
  | 'tool.result'
  | 'llm.request'
  | 'llm.delta'
  | 'llm.end'
  | 'permission.req'
  | 'permission.resolve'
  | 'prompt.snapshot'
  | 'identity.changed'
  | 'session.state'

interface TraceEvent {
  readonly id: string
  readonly turnId: string
  readonly parentTurnId?: string
  readonly sessionId?: string
  readonly type: TraceEventType
  readonly payload: Record<string, unknown>
  readonly timestamp: Date
  readonly cursor: number
}

interface TraceEventFactory {
  next: (
    turnId: string,
    type: TraceEventType,
    payload: Record<string, unknown>,
    parentTurnId?: string,
  ) => TraceEvent
  readonly lastCursor: number
}

function createTraceEventFactory(sessionId?: string): TraceEventFactory {
  let cursor = 0

  const factory: TraceEventFactory = {
    get lastCursor(): number {
      return cursor
    },

    next(
      turnId: string,
      type: TraceEventType,
      payload: Record<string, unknown>,
      parentTurnId?: string,
    ): TraceEvent {
      cursor += 1
      return {
        id: generateULID(),
        turnId,
        parentTurnId,
        sessionId,
        type,
        payload,
        timestamp: new Date(),
        cursor,
      }
    },
  }

  return factory
}

export { createTraceEventFactory }
export type { TraceEvent, TraceEventType, TraceEventFactory }
