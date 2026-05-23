import { describe, it, expect } from 'bun:test'
import { createTestKernel } from '../helpers/kernel-helper'
import { defineExtension } from '../../src/kernel/define-extension'
import traceExt from '../../src/extensions/trace'
import sessionExt from '../../src/extensions/session'
import providerExt from '../../src/extensions/provider'
import type { SessionStore } from '../../src/application/ports/session-store'
import type { TraceEvent } from '../../src/domain/trace-event'
import type { Session } from '../../src/domain/session'
import type { Turn } from '../../src/domain/turn'

/** Creates a test extension that captures all onTraceEmit dispatches. */
function createTraceCaptureExt() {
  const captured: TraceEvent[] = []
  const ext = defineExtension({
    name: 'test-trace-capture',
    enforce: 'normal',
    dependsOn: ['trace'],
    apply: () => ({
      hooks: {
        onTraceEmit: (async (...args: unknown[]) => {
          captured.push(args[0] as TraceEvent)
        }),
      },
    }),
  })
  return { ext, getEvents: (): readonly TraceEvent[] => captured }
}

describe('session extension', () => {
  it('should expose session.store capability after start', async () => {
    const k = createTestKernel({ extensions: [traceExt(), sessionExt()] })
    await k.start()

    const store = k.ctx.extensions.get<SessionStore>('session.store')
    expect(store).toBeDefined()
    expect(typeof store.save).toBe('function')
    expect(typeof store.load).toBe('function')
    expect(typeof store.list).toBe('function')
    expect(typeof store.delete).toBe('function')
    await k.stop()
  })

  it('should create main session persisted after kernelReady', async () => {
    const k = createTestKernel({
      agentId: 'test-profile',
      extensions: [traceExt(), sessionExt()],
    })
    await k.start()

    const store = k.ctx.extensions.get<SessionStore>('session.store')
    const mainSession = await store.load('main')
    expect(mainSession).not.toBeNull()
    expect(mainSession!.id).toBe('main')
    expect(mainSession!.agentId).toBe('test-profile')
    expect(mainSession!.isMain).toBe(true)
    expect(mainSession!.title).toBe('Main')
    expect(mainSession!.state).toBe('INIT')
    await k.stop()
  })

  it('should create turn and emit turn.started bus event on onTurnStart', async () => {
    const k = createTestKernel({ extensions: [traceExt(), sessionExt()] })
    await k.start()

    let busEvent: unknown = null
    k.ctx.bus.on('turn.started', (payload) => {
      busEvent = payload
    })

    // Dispatch onTurnStart — sequential hook returns the created Turn
    const turn = (await k.ctx.hooks.dispatch(
      'onTurnStart',
      'main',
      'fe-test',
    )) as Turn

    expect(turn).toBeDefined()
    expect(turn.id).toMatch(/^turn-/)
    expect(turn.sessionId).toBe('main')
    expect(turn.state).toBe('RUNNING')

    // Bus event emitted
    expect(busEvent).not.toBeNull()
    expect((busEvent as Record<string, unknown>).sessionId).toBe('main')
    expect((busEvent as Record<string, unknown>).turnId).toBe(turn.id)

    await k.stop()
  })

  it('should throw when onTurnStart called on RUNNING session', async () => {
    const k = createTestKernel({ extensions: [traceExt(), sessionExt()] })
    await k.start()

    // First turn — succeeds (INIT -> RUNNING)
    await k.ctx.hooks.dispatch('onTurnStart', 'main', 'fe-1')

    // Second turn on same session — should throw (RUNNING -> RUNNING invalid)
    let error: Error | null = null
    try {
      await k.ctx.hooks.dispatch('onTurnStart', 'main', 'fe-2')
    } catch (err) {
      error = err as Error
    }

    expect(error).not.toBeNull()
    expect(error!.message).toContain('Session is already running a turn')
    await k.stop()
  })

  it('should complete turn and dispatch onTraceEmit on onTurnEnd', async () => {
    const { ext: captureExt, getEvents } = createTraceCaptureExt()
    const k = createTestKernel({ extensions: [traceExt(), captureExt, sessionExt()] })
    await k.start()

    // Start a turn
    const turn = (await k.ctx.hooks.dispatch(
      'onTurnStart',
      'main',
      'fe-test',
    )) as Turn

    // End the turn
    await k.ctx.hooks.dispatch('onTurnEnd', {
      sessionId: 'main',
      turnId: turn.id,
      usage: { input: 42, output: 7 },
    })

    // Session should be back to IDLE
    const store = k.ctx.extensions.get<SessionStore>('session.store')
    const session = await store.load('main')
    expect(session!.state).toBe('IDLE')

    // onTraceEmit was dispatched with turn.completed trace event
    const events = getEvents()
    const completedEvent = events.find((e) => e.type === 'turn.completed')
    expect(completedEvent).toBeDefined()
    expect(completedEvent!.turnId).toBe(turn.id)
    expect(completedEvent!.payload).toMatchObject({ tokens: { input: 42, output: 7 } })

    await k.stop()
  })

  it('should write trace events via trace reader after onTurnStart and onTurnEnd', async () => {
    const { ext: captureExt, getEvents } = createTraceCaptureExt()
    const k = createTestKernel({ extensions: [traceExt(), captureExt, sessionExt()] })
    await k.start()

    // Start a turn
    const turn = (await k.ctx.hooks.dispatch(
      'onTurnStart',
      'main',
      'fe-test',
    )) as Turn

    // End the turn
    await k.ctx.hooks.dispatch('onTurnEnd', {
      sessionId: 'main',
      turnId: turn.id,
      usage: { input: 10, output: 5 },
    })

    // Check trace events captured via onTraceEmit hook
    const events = getEvents()

    // Should have at least turn.started and turn.completed
    expect(events.length).toBeGreaterThanOrEqual(2)

    const startedEvent = events.find((e) => e.type === 'turn.started')
    const completedEvent = events.find((e) => e.type === 'turn.completed')

    expect(startedEvent).toBeDefined()
    expect(startedEvent!.turnId).toBe(turn.id)
    expect(startedEvent!.payload).toMatchObject({
      sessionId: 'main',
      frontendId: 'fe-test',
    })

    expect(completedEvent).toBeDefined()
    expect(completedEvent!.turnId).toBe(turn.id)
    expect(completedEvent!.payload).toMatchObject({ tokens: { input: 10, output: 5 } })

    // Events should have monotonically increasing cursors
    expect(completedEvent!.cursor).toBeGreaterThan(startedEvent!.cursor)

    await k.stop()
  })

  it('should run full pipeline: trace + session + provider', async () => {
    const { ext: captureExt, getEvents } = createTraceCaptureExt()
    const k = createTestKernel({
      extensions: [traceExt(), captureExt, providerExt({ MY_AGENT_PROVIDER: 'echo' }), sessionExt()],
    })
    await k.start()

    // 1. Start a turn
    const turn = (await k.ctx.hooks.dispatch(
      'onTurnStart',
      'main',
      'fe-pipeline',
    )) as Turn
    expect(turn.state).toBe('RUNNING')

    // 2. Use provider.chat to stream a response
    const chat = k.ctx.extensions.get<{
      stream: (req: {
        messages: Array<{ role: string; content: string }>
      }) => AsyncGenerator<{ type: string; delta?: string }>
    }>('provider.llm')

    const chunks: unknown[] = []
    const deltas: unknown[] = []

    k.ctx.bus.on('llm.delta', (payload) => {
      deltas.push(payload)
    })

    for await (const chunk of chat.stream({
      messages: [{ role: 'user', content: 'pipeline test' }],
    })) {
      chunks.push(chunk)
      // Simulate what agent loop would do — dispatch onLLMDelta for each chunk
      await k.ctx.hooks.dispatch('onLLMDelta', chunk)
    }

    // Verify echo response (3 chunks: text, usage, done)
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toMatchObject({ type: 'text', delta: 'ECHO: pipeline test' })

    // 3. End the turn
    await k.ctx.hooks.dispatch('onTurnEnd', {
      sessionId: 'main',
      turnId: turn.id,
      usage: { input: 13, output: 19 },
    })

    // 4. Verify session is back to IDLE
    const store = k.ctx.extensions.get<SessionStore>('session.store')
    const session = await store.load('main')
    expect(session!.state).toBe('IDLE')

    // 5. Verify trace events recorded via onTraceEmit hook
    const events = getEvents()
    const startedEvent = events.find((e) => e.type === 'turn.started')
    const completedEvent = events.find((e) => e.type === 'turn.completed')

    expect(startedEvent).toBeDefined()
    expect(completedEvent).toBeDefined()
    expect(startedEvent!.turnId).toBe(turn.id)
    expect(completedEvent!.turnId).toBe(turn.id)

    await k.stop()
  })
})
