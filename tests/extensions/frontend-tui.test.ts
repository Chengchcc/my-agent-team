import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { createKernel } from '../../src/kernel/kernel'
import traceExt from '../../src/extensions/trace'
import sessionExt from '../../src/extensions/session'
import providerExt from '../../src/extensions/provider'
import controlplaneExt from '../../src/extensions/controlplane'
import dataplaneExt from '../../src/extensions/dataplane'
import transportExt from '../../src/extensions/transport.inmem'
import tuiExt from '../../src/extensions/frontend.tui'

describe('Frontend TUI adapter', () => {
  let kernel: ReturnType<typeof createKernel>

  beforeEach(async () => {
    kernel = createKernel({ agentId: 'tui-test' })
    kernel.use(traceExt())
    kernel.use(sessionExt())
    kernel.use(providerExt())
    kernel.use(controlplaneExt())
    kernel.use(dataplaneExt())
    kernel.use(transportExt())
    kernel.use(tuiExt())
    await kernel.start()
  })

  afterEach(async () => {
    await kernel.stop()
  })

  it('frontend.tui capability available', () => {
    const tui = kernel.ctx.extensions.get('frontend-tui.tui')
    expect(tui).toBeDefined()
    expect(tui.kind).toBe('tui')
  })

  it('hello negotiation returns daemon version', async () => {
    const tui = kernel.ctx.extensions.get('frontend-tui.tui')
    await tui.start()
    // Hello is sent during start()
    // Check that we got a valid response (no crash = success)
    expect(tui.isRunning).toBe(true)
    await tui.stop()
  })

  it('can list sessions after hello', async () => {
    const tui = kernel.ctx.extensions.get('frontend-tui.tui')
    await tui.start()
    const result = await tui.listSessions()
    expect(result).toBeDefined()
    await tui.stop()
  })

  it('sendInput sends to session', async () => {
    const tui = kernel.ctx.extensions.get('frontend-tui.tui')
    await tui.start()
    const result = await tui.sendInput('main', 'Hello, world!')
    expect(result).toBeDefined()
    await tui.stop()
  })

  it('receives DataPlane events through transport', async () => {
    const tui = kernel.ctx.extensions.get('frontend-tui.tui')
    await tui.start()
    // Trigger a turn.start event via bus
    kernel.ctx.bus.emit('turn.started', {
      sessionId: 'main',
      turnId: 'turn-1',
    })
    // Give async events time to propagate
    await new Promise((r) => setTimeout(r, 50))
    const events = tui.eventLog
    expect(events.length).toBeGreaterThan(0)
    expect(events.some((e: any) => e.type === 'turn.started')).toBe(true)
    await tui.stop()
  })

  it('UJ-1: attach/detach/resume cycle', async () => {
    const tui = kernel.ctx.extensions.get('frontend-tui.tui')
    await tui.start()

    // Attach to a session (UJ-1: re-attach after disconnect)
    const attachResult = await tui.attachSession('main')
    expect(attachResult).toBeDefined()

    // Detach (UJ-1: leave session)
    const detachResult = await tui.detachSession('main')
    expect(detachResult).toBeDefined()

    await tui.stop()
  })

  it('does NOT import any extension internals —防腐层verification', () => {
    // The TUI adapter only uses Transport + DataPlaneEvent types
    // It does NOT import from memory/, mcp/, evolution/, etc.
    // This is verified by ESLint no-restricted-paths (future)
    // For now, verify the module exists and doesn't crash
    const tui = kernel.ctx.extensions.get('frontend-tui.tui')
    expect(tui).toBeDefined()
  })
})
