import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test'
import { attachWidgetBridge } from '../../../src/extensions/sub-agent/widget-bridge'
import type { ContractBus } from '../../../src/application/event-bus/contract-bus'

describe('WidgetBridge', () => {
  let bus: { emit: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }
  let logger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> }
  let listeners: Map<string, (e: unknown) => void>

  beforeEach(() => {
    listeners = new Map()
    bus = {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: (e: unknown) => void) => {
        listeners.set(event, handler)
        return () => listeners.delete(event)
      }),
    }
    logger = { warn: vi.fn(), info: vi.fn() }
  })

  afterEach(() => {
    listeners.clear()
  })

  it('I-14: started → append, progress → replace, completed → replace + cleanup', () => {
    const dispose = attachWidgetBridge(bus as unknown as ContractBus, logger as any)

    listeners.get('subagent.started')?.({
      parentTurnId: 'T1', parentSessionId: 'S1', subSessionId: 'sub:1',
      type: 'explore', description: 'find X', callId: 'C1', ts: Date.now(),
    })
    expect(bus.emit).toHaveBeenCalledTimes(1)

    listeners.get('subagent.progress')?.({
      parentTurnId: 'T1', parentSessionId: 'S1', subSessionId: 'sub:1',
      callId: 'C1', innerCallId: 'T1#sub-C1:tc1', toolName: 'read',
      phase: 'start', ts: Date.now(),
    })

    listeners.get('subagent.progress')?.({
      parentTurnId: 'T1', parentSessionId: 'S1', subSessionId: 'sub:1',
      callId: 'C1', innerCallId: 'T1#sub-C1:tc1', toolName: 'read',
      phase: 'end', ok: true, durationMs: 100, ts: Date.now(),
    })

    listeners.get('subagent.completed')?.({
      parentTurnId: 'T1', parentSessionId: 'S1', subSessionId: 'sub:1',
      type: 'explore', callId: 'C1', ok: true,
      usage: { input: 10, output: 5 }, finalText: 'done',
      durationMs: 500, ts: Date.now(),
    })

    // 1 append + 2 progress replace + 1 completed replace = 4
    expect(bus.emit).toHaveBeenCalledTimes(4)
    dispose()
  })

  it('progress before started logs warn and does not emit', () => {
    const dispose = attachWidgetBridge(bus as unknown as ContractBus, logger as any)

    listeners.get('subagent.progress')?.({
      parentTurnId: 'T1', parentSessionId: 'S1', subSessionId: 'sub:1',
      callId: 'NONEXISTENT', innerCallId: 'x:tc1', toolName: 'read',
      phase: 'start', ts: Date.now(),
    })

    expect(logger.warn).toHaveBeenCalled()
    expect(bus.emit).toHaveBeenCalledTimes(0)
    dispose()
  })

  it('completed deletes state entry', () => {
    const dispose = attachWidgetBridge(bus as unknown as ContractBus, logger as any)

    listeners.get('subagent.started')?.({
      parentTurnId: 'T1', parentSessionId: 'S1', subSessionId: 'sub:2',
      type: 'plan', description: 'plan X', callId: 'C2', ts: Date.now(),
    })

    listeners.get('subagent.completed')?.({
      parentTurnId: 'T1', parentSessionId: 'S1', subSessionId: 'sub:2',
      type: 'plan', callId: 'C2', ok: false,
      usage: { input: 5, output: 0 }, durationMs: 200,
      errorType: 'failed', errorMessage: 'worker crash', ts: Date.now(),
    })

    expect(bus.emit).toHaveBeenCalledTimes(2) // append + replace
    dispose()
  })
})
