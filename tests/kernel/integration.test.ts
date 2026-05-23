import { describe, it, expect } from 'bun:test'
import { createKernel } from '../../src/kernel/kernel'
import { defineExtension } from '../../src/kernel/define-extension'
import type { ExtensionBuilder } from '../../src/kernel/define-extension'

// ---------------------------------------------------------------------------
// Shared state tracking
// ---------------------------------------------------------------------------

interface CallRecord {
  extension: string
  hook: string
  timestamp: number
  payload?: unknown
}

function record(
  calls: CallRecord[],
  extension: string,
  hook: string,
  payload?: unknown,
): void {
  calls.push({ extension, hook, timestamp: Date.now(), payload })
}

// ---------------------------------------------------------------------------
// Fake extension factories
//
// Each factory returns a frozen ExtensionBuilder. The extensions do NOT import
// each other — all inter-extension communication uses KernelContext capabilities,
// EventBus subscriptions, and HookContainer dispatch (INV-Kernel-1 compliance).
// ---------------------------------------------------------------------------

interface TraceWriter {
  write: (entry: string) => void
}

interface MemoryStore {
  recall: () => string
}

interface SessionStore {
  sessions: Map<string, unknown>
}

function createTraceExt(calls: CallRecord[]): ExtensionBuilder {
  return defineExtension({
    name: 'trace',
    enforce: 'pre',
    apply: () => ({
      provide: {
        writer: (): TraceWriter => ({
          write: (entry: string) => {
            record(calls, 'trace', 'writer.write', entry)
          },
        }),
      },
      hooks: {
        configureKernel: () => {
          record(calls, 'trace', 'configureKernel')
        },
        onShutdown: () => {
          record(calls, 'trace', 'onShutdown')
        },
      },
      dispose: () => {
        record(calls, 'trace', 'dispose')
      },
    }),
  })
}

function createMemoryExt(calls: CallRecord[]): ExtensionBuilder {
  return defineExtension({
    name: 'memory',
    enforce: 'normal',
    dependsOn: ['trace'],
    apply: (ctx) => {
      // Cross-extension capability resolution
      try {
        const writer = ctx.extensions.get<TraceWriter>('trace.writer')
        void writer // consumed
        record(calls, 'memory', 'capability-resolved.trace-writer')
      } catch {
        record(calls, 'memory', 'capability-missed')
      }

      return {
        provide: {
          store: (): MemoryStore => ({
            recall: () => 'memory context inserted',
          }),
        },
        hooks: {
          transformPrompt: async (prompt: unknown) => {
            record(calls, 'memory', 'transformPrompt', prompt)
            return `${prompt} [memory: recall]`
          },
          onTurnEnd: () => {
            record(calls, 'memory', 'onTurnEnd')
          },
          onTraceEmit: () => {
            record(calls, 'memory', 'onTraceEmit')
          },
        },
        subscribe: {
          'trace.flushed': () => {
            record(calls, 'memory', 'bus.trace.flushed')
          },
        },
        dispose: () => {
          record(calls, 'memory', 'dispose')
        },
      }
    },
  })
}

function createSessionExt(calls: CallRecord[]): ExtensionBuilder {
  return defineExtension({
    name: 'session',
    enforce: 'normal',
    apply: (ctx) => {
      // Capability resolution during apply
      try {
        const writer = ctx.extensions.get<TraceWriter>('trace.writer')
        void writer // consumed
        record(calls, 'session', 'capability-resolved.trace-writer')
      } catch {
        record(calls, 'session', 'capability-missed')
      }

      return {
        provide: {
          store: (): SessionStore => ({
            sessions: new Map(),
          }),
        },
        hooks: {
          onSessionCreated: () => {
            record(calls, 'session', 'onSessionCreated')
          },
          onTurnStart: () => {
            record(calls, 'session', 'onTurnStart')
          },
          kernelReady: () => {
            record(calls, 'session', 'kernelReady')
          },
          onLLMDelta: () => {
            record(calls, 'session', 'onLLMDelta')
          },
        },
        dispose: () => {
          record(calls, 'session', 'dispose')
        },
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('Kernel Integration (3 extensions)', () => {
  /**
   * Test 1: All 3 extensions loaded in correct order.
   *
   * Sorting key: (kahnLayer, enforceWeight, name).
   *   trace   → kahnLayer 0, enforceWeight 0 (pre),  no deps
   *   session → kahnLayer 0, enforceWeight 1 (normal), no deps
   *   memory  → kahnLayer 1, enforceWeight 1 (normal), deps=['trace']
   *
   * Expected registration order: trace → session → memory
   */
  it('should load all 3 extensions in correct order (trace -> session -> memory)', async () => {
    const calls: CallRecord[] = []
    const trace = createTraceExt(calls)
    const memory = createMemoryExt(calls)
    const session = createSessionExt(calls)

    const k = createKernel({ agentId: 'test' })
    // Register out of order to verify topo-sort reorders
    k.use(session).use(memory).use(trace)
    await k.start()

    expect(k.ctx.extensions.list()).toEqual(['trace', 'session', 'memory'])
    await k.stop()
  })

  /**
   * Test 2: kernelReady fires for all extensions that registered it.
   *
   * trace does NOT register kernelReady.
   * session DOES register kernelReady.
   */
  it('should fire kernelReady for all extensions that registered it (trace does NOT)', async () => {
    const calls: CallRecord[] = []
    const trace = createTraceExt(calls)
    const memory = createMemoryExt(calls)
    const session = createSessionExt(calls)

    const k = createKernel({ agentId: 'test' })
    k.use(trace).use(memory).use(session)
    await k.start()

    const kernelReadyCalls = calls.filter((c) => c.hook === 'kernelReady')
    expect(kernelReadyCalls).toHaveLength(1)
    expect(kernelReadyCalls[0]!.extension).toBe('session')

    // Verify trace was NOT invoked for kernelReady
    const traceKernelReady = calls.filter(
      (c) => c.extension === 'trace' && c.hook === 'kernelReady',
    )
    expect(traceKernelReady).toHaveLength(0)

    await k.stop()
  })

  /**
   * Test 3: configureKernel fires in order before kernelReady.
   *
   * configureKernel is 'sequential' mode. Only trace registers it.
   * Verifies it runs during start() and completes before kernelReady.
   */
  it('should fire configureKernel before kernelReady (sequential dispatch order)', async () => {
    const calls: CallRecord[] = []
    const trace = createTraceExt(calls)
    const memory = createMemoryExt(calls)
    const session = createSessionExt(calls)

    const k = createKernel({ agentId: 'test' })
    k.use(trace).use(memory).use(session)
    await k.start()

    // configureKernel was dispatched — only trace registered it
    const configCalls = calls.filter((c) => c.hook === 'configureKernel')
    expect(configCalls).toHaveLength(1)
    expect(configCalls[0]!.extension).toBe('trace')

    // configureKernel fires before kernelReady in the start() lifecycle
    const configIdx = calls.findIndex((c) => c.hook === 'configureKernel')
    const readyIdx = calls.findIndex((c) => c.hook === 'kernelReady')
    expect(configIdx).toBeGreaterThanOrEqual(0)
    expect(readyIdx).toBeGreaterThanOrEqual(0)
    expect(configIdx).toBeLessThan(readyIdx)

    await k.stop()
  })

  /**
   * Test 4: Capability resolution across extensions.
   *
   * Both memory (dependsOn trace) and session (enforce-ordered after trace)
   * can resolve trace.writer capability during their apply phase.
   */
  it('should resolve trace.writer capability in both memory and session during apply', async () => {
    const calls: CallRecord[] = []
    const trace = createTraceExt(calls)
    const memory = createMemoryExt(calls)
    const session = createSessionExt(calls)

    const k = createKernel({ agentId: 'test' })
    k.use(trace).use(memory).use(session)
    await k.start()

    // Both extensions should have successfully resolved the capability
    const resolved = calls.filter((c) => c.hook === 'capability-resolved.trace-writer')
    expect(resolved).toHaveLength(2)
    expect(resolved.map((c) => c.extension).sort()).toEqual(['memory', 'session'])

    // No misses
    const missed = calls.filter((c) => c.hook === 'capability-missed')
    expect(missed).toHaveLength(0)

    // Also verify runtime capability access works post-start
    const writer = k.ctx.extensions.get<TraceWriter>('trace.writer')
    expect(writer).toBeDefined()
    expect(typeof writer.write).toBe('function')

    await k.stop()
  })

  /**
   * Test 5: EventBus cross-extension communication.
   *
   * memory subscribes to 'trace.flushed' via the bus.
   * When the test emits that event, memory's subscriber runs.
   * No extension imports another directly — communication is via the shared bus.
   */
  it('should enable EventBus cross-extension communication (trace.flushed -> memory)', async () => {
    const calls: CallRecord[] = []
    const trace = createTraceExt(calls)
    const memory = createMemoryExt(calls)
    const session = createSessionExt(calls)

    const k = createKernel({ agentId: 'test' })
    k.use(trace).use(memory).use(session)
    await k.start()

    // Verify memory subscribed to 'trace.flushed'
    expect(k.ctx.bus.subscriberCount('trace.flushed')).toBe(1)

    // Emit the event
    const payload = { timestamp: Date.now() }
    await k.ctx.bus.emit('trace.flushed', payload)

    const busCalls = calls.filter((c) => c.hook === 'bus.trace.flushed')
    expect(busCalls).toHaveLength(1)
    expect(busCalls[0]!.extension).toBe('memory')

    await k.stop()
  })

  /**
   * Test 6: transformPrompt sequential hook pipeline.
   *
   * transformPrompt is 'sequential' mode — each handler receives and
   * transforms the payload. Only memory registers it for this suite.
   * The result reflects memory's transformation.
   */
  it('should chain payload through transformPrompt sequential pipeline', async () => {
    const calls: CallRecord[] = []
    const trace = createTraceExt(calls)
    const memory = createMemoryExt(calls)
    const session = createSessionExt(calls)

    const k = createKernel({ agentId: 'test' })
    k.use(trace).use(memory).use(session)
    await k.start()

    const result = await k.ctx.hooks.dispatch('transformPrompt', 'hello')

    // Sequential pipeline: initial payload 'hello' passes through memory handler
    expect(result).toBe('hello [memory: recall]')

    // Verify memory's transformPrompt was called with correct input
    const transformCalls = calls.filter((c) => c.hook === 'transformPrompt')
    expect(transformCalls).toHaveLength(1)
    expect(transformCalls[0]!.extension).toBe('memory')
    expect(transformCalls[0]!.payload).toBe('hello')

    await k.stop()
  })

  /**
   * Test 7: Full lifecycle.
   *
   * start() → dispatch several hooks → emit bus events → stop()
   *
   * Verifies:
   *   - All registered hooks fire
   *   - Bus events bridge extensions
   *   - onShutdown fires before dispose
   *   - dispose runs in reverse registration order
   */
  it('should execute full lifecycle: start -> hooks -> bus -> stop -> dispose reverse', async () => {
    const calls: CallRecord[] = []
    const trace = createTraceExt(calls)
    const memory = createMemoryExt(calls)
    const session = createSessionExt(calls)

    const k = createKernel({ agentId: 'test' })
    k.use(trace).use(memory).use(session)
    await k.start()

    // Dispatch hooks through the HookContainer
    await k.ctx.hooks.dispatch('onSessionCreated', { sessionId: 's1' })
    await k.ctx.hooks.dispatch('onTurnStart', { turn: 1 })
    await k.ctx.hooks.dispatch('onLLMDelta', { delta: 'text' })
    const promptResult = await k.ctx.hooks.dispatch('transformPrompt', 'hello')
    await k.ctx.hooks.dispatch('onTurnEnd', { turn: 1 })
    await k.ctx.hooks.dispatch('onTraceEmit', { trace: 'data' })

    // Bus communication
    await k.ctx.bus.emit('trace.flushed', {})

    // Verify transformPrompt pipeline produced correct output
    expect(promptResult).toBe('hello [memory: recall]')

    // Verify all dispatched hooks appear in call records
    const hookNames = [...new Set(calls.map((c) => c.hook))]
    expect(hookNames).toContain('configureKernel')
    expect(hookNames).toContain('kernelReady')
    expect(hookNames).toContain('onSessionCreated')
    expect(hookNames).toContain('onTurnStart')
    expect(hookNames).toContain('onLLMDelta')
    expect(hookNames).toContain('transformPrompt')
    expect(hookNames).toContain('onTurnEnd')
    expect(hookNames).toContain('onTraceEmit')
    expect(hookNames).toContain('bus.trace.flushed')

    // Verify each hook was called by the correct extension
    expect(calls.find((c) => c.hook === 'onSessionCreated')!.extension).toBe('session')
    expect(calls.find((c) => c.hook === 'onTurnStart')!.extension).toBe('session')
    expect(calls.find((c) => c.hook === 'onLLMDelta')!.extension).toBe('session')
    expect(calls.find((c) => c.hook === 'onTurnEnd')!.extension).toBe('memory')
    expect(calls.find((c) => c.hook === 'onTraceEmit')!.extension).toBe('memory')
    expect(calls.find((c) => c.hook === 'bus.trace.flushed')!.extension).toBe('memory')

    await k.stop()

    // --- Post-stop assertions ---

    // onShutdown must have been dispatched for trace
    const shutdownCalls = calls.filter((c) => c.hook === 'onShutdown')
    expect(shutdownCalls).toHaveLength(1)
    expect(shutdownCalls[0]!.extension).toBe('trace')

    // Dispose called for all 3 extensions in reverse registration order
    const disposeCalls = calls.filter((c) => c.hook === 'dispose')
    expect(disposeCalls).toHaveLength(3)
    // Reverse of [trace, session, memory] = [memory, session, trace]
    expect(disposeCalls[0]!.extension).toBe('memory')
    expect(disposeCalls[1]!.extension).toBe('session')
    expect(disposeCalls[2]!.extension).toBe('trace')

    // onShutdown fires before dispose
    const shutdownIdx = calls.findIndex((c) => c.hook === 'onShutdown')
    const firstDisposeIdx = calls.findIndex((c) => c.hook === 'dispose')
    expect(shutdownIdx).toBeLessThan(firstDisposeIdx)

    // After stop, registry should be empty
    expect(k.ctx.extensions.list()).toEqual([])
    expect(k.ctx.bus.subscriberCount('trace.flushed')).toBe(0)
  })

  /**
   * Test 8: INV-Kernel-1 compliance.
   *
   * No extension imports another extension directly.
   * All inter-extension communication uses:
   *   - Capability resolution via KernelContext.extensions.get()
   *   - EventBus subscriptions (subscribe field in apply result)
   *   - Hook chaining through HookContainer
   *
   * This is verified by construction: each extension is defined by an
   * independent factory function with zero static imports of other
   * extension modules.
   */
  it('should avoid INV-Kernel-1 violation: no extension imports another directly', () => {
    const calls: CallRecord[] = []
    const trace = createTraceExt(calls)
    const memory = createMemoryExt(calls)
    const session = createSessionExt(calls)

    // All three are independent ExtensionBuilder objects
    expect(trace.name).toBe('trace')
    expect(memory.name).toBe('memory')
    expect(session.name).toBe('session')

    // memory declares dependency via dependsOn (declarative), not import
    expect(memory.dependsOn).toContain('trace')
    expect(memory.dependsOn).toHaveLength(1)

    // session has zero dependencies — no static coupling
    expect(session.dependsOn).toHaveLength(0)

    // trace has zero dependencies — no static coupling
    expect(trace.dependsOn).toHaveLength(0)

    // Each extension's apply function is independently defined.
    // Communication paths:
    //   - memory → trace.writer: via ctx.extensions.get (capability)
    //   - memory → trace.flushed: via ctx.bus (event bus subscription)
    //   - session → trace.writer: via ctx.extensions.get (capability)
    // No extension invokes another extension's functions directly.
    //
    // This is verified structurally: defineExtension produces frozen,
    // standalone objects. The Kernel wires them together at start() time.
  })
})
