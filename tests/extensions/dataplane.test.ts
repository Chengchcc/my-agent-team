import { describe, it, expect } from 'bun:test'
import { createTestKernel } from '../helpers/kernel-helper'
import dataplaneExt from '../../src/extensions/dataplane'
import type { DataPlaneEvent } from '../../src/application/contracts'

interface DataPlaneStream {
  replay: (since?: number) => DataPlaneEvent[]
  getCursor: () => number
  getEventCount: () => number
  clear: () => void
}

describe('dataplane extension', () => {
  it('dataplane.stream capability should be available', async () => {
    const k = createTestKernel({ extensions: [dataplaneExt()] })
    await k.start()

    const stream = k.ctx.extensions.get('dataplane.stream')
    expect(stream).toBeDefined()
    expect(typeof stream.replay).toBe('function')
    expect(typeof stream.getCursor).toBe('function')
    expect(typeof stream.getEventCount).toBe('function')
    expect(typeof stream.clear).toBe('function')

    await k.stop()
  })

  it('should replay events since cursor', async () => {
    const k = createTestKernel({ extensions: [dataplaneExt()] })
    await k.start()

    // Emit some bus events that DataPlane subscribes to
    await k.ctx.bus.emit('turn.started', {
      sessionId: 'main',
      turnId: 'turn-1',
    })
    await k.ctx.bus.emit('llm.delta', {
      type: 'text',
      delta: 'Hello',
    })
    await k.ctx.bus.emit('permission.required', {
      reqId: 'perm-1',
      toolName: 'bash',
    })

    const stream = k.ctx.extensions.get('dataplane.stream')

    // Full replay
    const all = stream.replay()
    expect(all).toHaveLength(3)

    // Since cursor 1 — should get events 2 and 3
    const since1 = stream.replay(1)
    expect(since1).toHaveLength(2)
    expect(since1[0].cursor).toBe(2)
    expect(since1[1].cursor).toBe(3)

    // Since cursor 3 — should get empty
    const since3 = stream.replay(3)
    expect(since3).toHaveLength(0)

    await k.stop()
  })

  it('cursor should be monotonically increasing', async () => {
    const k = createTestKernel({ extensions: [dataplaneExt()] })
    await k.start()

    const stream = k.ctx.extensions.get('dataplane.stream')
    expect(stream.getCursor()).toBe(0)

    await k.ctx.bus.emit('turn.started', { sessionId: 'main', turnId: 't1' })
    expect(stream.getCursor()).toBe(1)

    await k.ctx.bus.emit('turn.completed', { sessionId: 'main', turnId: 't1' })
    expect(stream.getCursor()).toBe(2)

    await k.ctx.bus.emit('identity.changed', { field: 'preferences' })
    expect(stream.getCursor()).toBe(3)

    // Verify cursor is strictly increasing across all events
    const all = stream.replay()
    expect(all[0].cursor).toBe(1)
    expect(all[1].cursor).toBe(2)
    expect(all[2].cursor).toBe(3)

    await k.stop()
  })

  it('bus events should be converted to DataPlane format', async () => {
    const k = createTestKernel({ extensions: [dataplaneExt()] })
    await k.start()

    await k.ctx.bus.emit('turn.started', {
      sessionId: 'main',
      turnId: 'turn-x',
    })
    await k.ctx.bus.emit('llm.delta', {
      type: 'text',
      delta: 'streaming text',
    })

    const stream = k.ctx.extensions.get('dataplane.stream')
    const events = stream.replay()

    // turn.started event
    expect(events[0]).toBeDefined()
    expect(events[0].evId).toMatch(/^ev-/)
    expect(events[0].cursor).toBeGreaterThan(0)
    expect(events[0].ts).toBeDefined()
    expect(typeof events[0].ts).toBe('number')
	    // Verify epoch timestamp is reasonable (after 2020)
	    expect(events[0].ts).toBeGreaterThan(1577836800000)
    expect(events[0].sessionId).toBe('main')
    expect(events[0].type).toBe('turn.started')
    expect(events[0].target).toBeUndefined()
    expect(events[0].payload).toMatchObject({
      sessionId: 'main',
      turnId: 'turn-x',
    })

    // llm.delta event
    expect(events[1].payload).toMatchObject({
      type: 'text',
      delta: 'streaming text',
    })

    expect(events[1].cursor).toBeGreaterThan(events[0].cursor)

    await k.stop()
  })

  it('event types should be correct (turn.started -> turn.started, llm.delta -> assistant.delta)', async () => {
    const k = createTestKernel({ extensions: [dataplaneExt()] })
    await k.start()

    await k.ctx.bus.emit('turn.started', { sessionId: 's', turnId: 't' })
    await k.ctx.bus.emit('llm.delta', { type: 'text', delta: 'x' })
    await k.ctx.bus.emit('tool.start', { name: 'read' })
    await k.ctx.bus.emit('permission.required', { toolName: 'bash' })
    await k.ctx.bus.emit('identity.changed', { field: 'profile' })

    const stream = k.ctx.extensions.get('dataplane.stream')
    const events = stream.replay()

    expect(events).toHaveLength(5)
    expect(events[0].type).toBe('turn.started')
    expect(events[1].type).toBe('assistant.delta')
    expect(events[2].type).toBe('tool.update')
    expect(events[3].type).toBe('permission.required')
    expect(events[4].type).toBe('identity.changed')

    await k.stop()
  })
})
