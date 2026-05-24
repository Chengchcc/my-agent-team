import { defineExtension } from '../../kernel/define-extension'
import type { DataPlaneEvent, DataPlaneEventType } from '../../application/contracts'

// ── Event factory (runtime, not a contract) ───────────────────────────────────

function createEventFactory() {
  let cursor = 0;
  return {
    next(
      type: DataPlaneEventType,
      payload: Record<string, unknown>,
      opts?: { sessionId?: string | undefined; turnId?: string | undefined; target?: string },
    ): DataPlaneEvent {
      cursor += 1;
      return {
        type,
        version: 1,
        ts: Date.now(),
        sessionId: opts?.sessionId,
        turnId: opts?.turnId,
        payload,
        evId: `ev-${cursor}`,
        cursor,
        target: opts?.target,
      };
    },
    get lastCursor(): number {
      return cursor;
    },
  };
}

/**
 * DataPlane extension — event cursor stream for frontends.
 *
 * Runs LAST (enforce: 'post') so that all event-emitting extensions are
 * registered before DataPlane begins subscribing.
 *
 * Capabilities exposed:
 *   - dataplane.stream: Event stream (replay, getCursor, getEventCount, clear)
 *
 * Subscribes to upstream bus events and converts them to DataPlane format
 * with monotonically increasing cursors.
 */
export default () =>
  defineExtension({
    name: 'dataplane',
    enforce: 'post',
    apply: (ctx) => {
      const eventLog: DataPlaneEvent[] = []
      const factory = createEventFactory()

      // Subscribe to ALL business events and convert to DataPlane format.
      // Map: [busEvent, dataPlaneEventType]
      const eventMappings: Array<[string, DataPlaneEventType]> = [
        ['turn.started', 'turn.started'],
        ['turn.completed', 'turn.completed'],
        ['llm.delta', 'assistant.delta'],
        ['tool.start', 'tool.update'],
        ['tool.end', 'tool.update'],
        ['permission.required', 'permission.required'],
        ['permission.resolved', 'permission.resolved'],
        ['ask-user-question.required', 'ask-user-question.required'],
        ['ask-user-question.resolved', 'ask-user-question.resolved'],
        ['identity.changed', 'identity.changed'],
        ['turn.failed', 'turn.failed'],
        ['tui.inline-block', 'tui.inline-block'],
        ['subagent.started', 'sub-agent.started'],
        ['subagent.completed', 'sub-agent.completed'],
        ['compaction.started', 'compaction.started'],
        ['compaction.completed', 'compaction.completed'],
        ['compaction.failed', 'compaction.failed'],
      ]

      // Subscribe to mapped events
      for (const [busEvent, dpType] of eventMappings) {
        ctx.bus.on(busEvent, async (raw: unknown) => {
          const r = (raw as Record<string, unknown> | undefined) ?? {}
          // Detect envelope (EventEnvelope<T>) vs plain payload
          const isEnvelope = typeof r.payload === 'object' && r.payload !== null
                          && typeof r.type === 'string' && typeof r.version === 'number'
          const sessionId = (isEnvelope ? r.sessionId : r.sessionId) as string | undefined
          const turnId    = (isEnvelope ? r.turnId    : r.turnId)    as string | undefined
          const p         = isEnvelope ? r.payload as Record<string, unknown> : r
          // Tag tool lifecycle events with phase for TUI
          const withPhase = (busEvent === 'tool.start' || busEvent === 'tool.end')
            ? { ...p, phase: busEvent === 'tool.start' ? 'start' : 'end' }
            : p
          const evt = factory.next(dpType, withPhase, { sessionId, turnId })
          eventLog.push(evt)
          // Forward to bus so transport adapters (InMemoryTransport, etc.)
          // can relay events to frontends.
          ctx.logger.info('dataplane', `emit dataplane.event type=${evt.type}`)
          await ctx.bus.emit('dataplane.event', evt)
        })
      }

      return {
        provide: {
          stream: () => ({
            /** Replay events since a cursor, or all if no cursor */
            replay(since?: number): DataPlaneEvent[] {
              if (since === undefined) return [...eventLog]
              return eventLog.filter((e) => e.cursor > since)
            },

            /** Get latest cursor for reconnect */
            getCursor(): number {
              return factory.lastCursor
            },

            /** Get total event count */
            getEventCount(): number {
              return eventLog.length
            },

            /** Clear event log */
            clear(): void {
              eventLog.length = 0
            },
          }),
        },

        dispose: () => {
          eventLog.length = 0
        },
      }
    },
  })
