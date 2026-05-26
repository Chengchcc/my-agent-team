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

// ── Envelope detection helper ────────────────────────────────────────────────

function extractPayload(raw: unknown): {
  payload: Record<string, unknown>;
  sessionId?: string;
  turnId?: string;
} {
  const r = (raw as Record<string, unknown> | undefined) ?? {}
  // Detect EventEnvelope: { type, version, ts, sessionId, turnId, payload }
  const isEnvelope =
    typeof r.payload === 'object' && r.payload !== null &&
    typeof r.type === 'string' && typeof r.version === 'number'
  return {
    payload: (isEnvelope ? r.payload : r) as Record<string, unknown>,
    sessionId: (isEnvelope ? r.sessionId : r.sessionId) as string | undefined,
    turnId: (isEnvelope ? r.turnId : r.turnId) as string | undefined,
  }
}

/**
 * DataPlane extension — event cursor stream for frontends.
 *
 * Runs LAST (enforce: 'post') so that all event-emitting extensions are
 * registered before DataPlane begins subscribing.
 *
 * Capabilities exposed:
 *   - dataplane.register: Allow producer extensions to register bus→DataPlane mappings.
 *   - dataplane.stream: Event stream (replay, getCursor, getEventCount, clear).
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

      /**
       * Register a raw bus event → DataPlane event mapping at runtime.
       * Other extensions call this to subscribe their own events.
       */
      function register(
        rawType: string,
        mapper: (raw: unknown) => { dpType: DataPlaneEventType; payload: Record<string, unknown>; sessionId?: string; turnId?: string },
      ): void {
        ctx.bus.on(rawType, async (raw: unknown) => {
          const mapped = mapper(raw)
          const evt = factory.next(mapped.dpType, mapped.payload, { sessionId: mapped.sessionId, turnId: mapped.turnId })
          eventLog.push(evt)
          ctx.logger.info('dataplane', `emit dataplane.event type=${evt.type}`)
          await ctx.bus.emit('dataplane.event', evt)
        })
      }

      // ── Built-in event mappings (core system events) ──────────────────────────
      // Each entry registers the raw bus event → DataPlane event translation.
      // Producer extensions register their own mappings via dataplane.register.

      const builtInMappings: Array<{ busEvent: string; dpType: DataPlaneEventType }> = [
        { busEvent: 'turn.started', dpType: 'turn.started' },
        { busEvent: 'turn.completed', dpType: 'turn.completed' },
        { busEvent: 'llm.delta', dpType: 'assistant.delta' },
        { busEvent: 'tool.start', dpType: 'tool.update' },
        { busEvent: 'tool.end', dpType: 'tool.update' },
        { busEvent: 'permission.required', dpType: 'permission.required' },
        { busEvent: 'permission.resolved', dpType: 'permission.resolved' },
        { busEvent: 'ask-user-question.required', dpType: 'ask-user-question.required' },
        { busEvent: 'ask-user-question.resolved', dpType: 'ask-user-question.resolved' },
        { busEvent: 'identity.changed', dpType: 'identity.changed' },
        { busEvent: 'turn.failed', dpType: 'turn.failed' },
        { busEvent: 'tui.inline-block', dpType: 'tui.inline-block' },
        { busEvent: 'subagent.started', dpType: 'sub-agent.started' },
        { busEvent: 'subagent.completed', dpType: 'sub-agent.completed' },
        { busEvent: 'compaction.started', dpType: 'compaction.started' },
        { busEvent: 'compaction.completed', dpType: 'compaction.completed' },
        { busEvent: 'compaction.failed', dpType: 'compaction.failed' },
      ]

      for (const { busEvent, dpType } of builtInMappings) {
        register(busEvent, (raw) => {
          const { payload, sessionId, turnId } = extractPayload(raw)
          // Tag tool lifecycle events with phase for TUI
          if (busEvent === 'tool.start' || busEvent === 'tool.end') {
            return {
              dpType,
              payload: { ...payload, phase: busEvent === 'tool.start' ? 'start' : 'end' },
              sessionId,
              turnId,
            }
          }
          return { dpType, payload, sessionId, turnId }
        })
      }

      return {
        provide: {
          'dataplane.register': () => register,
          'dataplane.stream': () => ({
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
