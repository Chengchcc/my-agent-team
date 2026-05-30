import { emitInlineBlock } from '../../application/contracts/widget-events'
import type { ContractBus } from '../../application/event-bus/contract-bus'
import type { Logger } from '../../application/ports/logger'
import type { SubAgentStartedV1, SubAgentCompletedV1, SubAgentProgressV1 } from '../../application/contracts/subagent-events'
import type { SubAgentTaskPayload, SubAgentInnerToolCall } from './widget-payloads'

const WIDGET_TIMEOUT_MS = 30 * 60 * 1000
const SWEEP_INTERVAL_MS = 5 * 60 * 1000

interface BridgeEntry {
  payload: SubAgentTaskPayload
  parentSessionId: string
  parentTurnId: string
  startedAt: number
  blockId: string
}

export function attachWidgetBridge(bus: ContractBus, logger: Logger): () => void {
  const state = new Map<string, BridgeEntry>()

  function emit(entry: BridgeEntry, mode: 'append' | 'replace') {
    emitInlineBlock(bus, {
      sessionId: entry.parentSessionId,
      widget: 'subagent.task',
      payload: entry.payload,
      blockId: entry.blockId,
      mode,
    })
  }

  const sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [callId, entry] of state) {
      if (now - entry.startedAt > WIDGET_TIMEOUT_MS) {
        entry.payload = {
          ...entry.payload,
          status: 'failed',
          errorMessage: 'timeout: no completion received within 30min',
        }
        emit(entry, 'replace')
        state.delete(callId)
      }
    }
  }, SWEEP_INTERVAL_MS)

  const offStarted = bus.on('subagent.started', (e: SubAgentStartedV1) => {
    const blockId = `task:${e.parentTurnId}:${e.callId}`
    const payload: SubAgentTaskPayload = {
      callId: e.callId,
      subagentType: e.type,
      description: e.description,
      status: 'running',
      subSessionId: e.subSessionId,
      innerToolCalls: [],
    }
    state.set(e.callId, {
      payload,
      parentSessionId: e.parentSessionId,
      parentTurnId: e.parentTurnId,
      startedAt: e.ts,
      blockId,
    })
    emit(state.get(e.callId)!, 'append')
  })

  const offProgress = bus.on('subagent.progress', (e: SubAgentProgressV1) => {
    const entry = state.get(e.callId)
    if (!entry) {
      logger.warn('sub-agent.widget-bridge', `progress for unknown callId=${e.callId}`)
      return
    }
    let inner: ReadonlyArray<SubAgentInnerToolCall>
    if (e.phase === 'start') {
      inner = [...entry.payload.innerToolCalls, { innerCallId: e.innerCallId, name: e.toolName, status: 'running' }]
    } else {
      inner = entry.payload.innerToolCalls.map(it =>
        it.innerCallId === e.innerCallId
          ? { ...it, status: e.ok ? 'ok' : 'error', durationMs: e.durationMs }
          : it,
      )
    }
    entry.payload = { ...entry.payload, innerToolCalls: inner }
    emit(entry, 'replace')
  })

  const offCompleted = bus.on('subagent.completed', (e: SubAgentCompletedV1) => {
    const entry = state.get(e.callId)
    if (!entry) return
    const status: SubAgentTaskPayload['status'] = e.ok
      ? 'ok'
      : (e.errorType === 'cancelled' ? 'cancelled' : 'failed')
    entry.payload = {
      ...entry.payload,
      status,
      finalText: e.finalText,
      usage: e.usage,
      errorMessage: e.errorMessage,
      errorType: e.errorType,
      durationMs: e.durationMs,
    }
    emit(entry, 'replace')
    state.delete(e.callId)
  })

  return () => {
    offStarted()
    offProgress()
    offCompleted()
    clearInterval(sweepTimer)
    state.clear()
  }
}
