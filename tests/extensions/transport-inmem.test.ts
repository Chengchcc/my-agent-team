import { describe, it, expect } from 'bun:test'
import { createTestKernel } from '../helpers/kernel-helper'
import controlplaneExt from '../../src/extensions/controlplane'
import dataplaneExt from '../../src/extensions/dataplane'
import transportInmemExt from '../../src/extensions/transport.inmem'
import type { Transport } from '../../src/application/ports/transport'
import type { DataPlaneEvent } from '../../src/application/contracts'

describe('transport.inmem extension', () => {
  it('transport capability should be available after kernel start', async () => {
    const k = createTestKernel({
      extensions: [dataplaneExt(), controlplaneExt(), transportInmemExt()],
    })
    await k.start()

    const transport = k.ctx.extensions.get<Transport>('transport-inmem.transport')
    expect(transport).toBeDefined()
    expect(typeof transport.sendRpc).toBe('function')
    expect(typeof transport.onEvent).toBe('function')
    expect(typeof transport.close).toBe('function')

    await transport.close()
    await k.stop()
  })

  it('sendRpc should route to controlplane — hello returns agentId', async () => {
    const k = createTestKernel({
      agentId: 'tpt-test',
      extensions: [dataplaneExt(), controlplaneExt(), transportInmemExt()],
    })
    await k.start()

    const transport = k.ctx.extensions.get<Transport>('transport-inmem.transport')

    const result = await transport.sendRpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'hello',
    })

    expect(result).not.toBeNull()
    expect(result!.jsonrpc).toBe('2.0')
    expect(result!.result).toBeDefined()
    const r = result!.result as Record<string, unknown>
    expect(r.daemonVersion).toBe('2.0.0')
    expect(r.agentId).toBe('tpt-test')
    expect(r.capabilities).toEqual({ events: 16, methods: 24 })

    await transport.close()
    await k.stop()
  })

  it('sendRpc unknown method should return METHOD_NOT_FOUND (-32601)', async () => {
    const k = createTestKernel({
      extensions: [dataplaneExt(), controlplaneExt(), transportInmemExt()],
    })
    await k.start()

    const transport = k.ctx.extensions.get<Transport>('transport-inmem.transport')

    const result = await transport.sendRpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'nonexistent.method',
    })

    expect(result).not.toBeNull()
    expect(result!.error).toBeDefined()
    const err = result!.error as { code: number; message: string }
    expect(err.code).toBe(-32601)
    expect(err.message).toBe('Method not found')

    await transport.close()
    await k.stop()
  })

  it('onEvent should receive DataPlane events from bus', async () => {
    const k = createTestKernel({
      extensions: [dataplaneExt(), controlplaneExt(), transportInmemExt()],
    })
    await k.start()

    const transport = k.ctx.extensions.get<Transport>('transport-inmem.transport')

    const received: DataPlaneEvent[] = []
    transport.onEvent((event) => {
      received.push(event)
    })

    // Emit bus events that DataPlane maps and forwards as dataplane.event
    await k.ctx.bus.emit('turn.started', {
      sessionId: 'main',
      turnId: 'turn-1',
    })
    await k.ctx.bus.emit('llm.delta', {
      type: 'text',
      delta: 'Hello from transport',
    })
    await k.ctx.bus.emit('tool.start', {
      name: 'read',
    })

    // DataPlane subscribes to bus events, creates DataPlaneEvent,
    // then emits 'dataplane.event' — which InMemoryTransport forwards
    // to our handler. Since emit is fully async (awaits all subscribers),
    // the events are guaranteed to be delivered after the emit resolves.
    expect(received.length).toBe(3)
    expect(received[0]!.type).toBe('turn.started')
    expect(received[0]!.payload).toMatchObject({
      sessionId: 'main',
      turnId: 'turn-1',
    })
    expect(received[1]!.type).toBe('assistant.delta')
    expect(received[1]!.payload).toMatchObject({
      type: 'text',
      delta: 'Hello from transport',
    })
    expect(received[2]!.type).toBe('tool.update')
    expect(received[2]!.payload).toMatchObject({
      name: 'read',
      phase: 'start',
    })

    // Cursors should be monotonically increasing
    expect(received[0]!.cursor).toBeLessThan(received[1]!.cursor)
    expect(received[1]!.cursor).toBeLessThan(received[2]!.cursor)

    await transport.close()
    await k.stop()
  })

  it('unsubscribe should stop receiving events', async () => {
    const k = createTestKernel({
      extensions: [dataplaneExt(), controlplaneExt(), transportInmemExt()],
    })
    await k.start()

    const transport = k.ctx.extensions.get<Transport>('transport-inmem.transport')

    const received: DataPlaneEvent[] = []
    const unsub = transport.onEvent((event) => {
      received.push(event)
    })

    // Receive first event
    await k.ctx.bus.emit('turn.started', {
      sessionId: 's',
      turnId: 'before-unsub',
    })
    expect(received.length).toBe(1)
    expect(received[0]!.payload).toMatchObject({ turnId: 'before-unsub' })

    // Unsubscribe
    unsub()

    // This event should NOT be received
    await k.ctx.bus.emit('turn.started', {
      sessionId: 's',
      turnId: 'after-unsub',
    })
    expect(received.length).toBe(1) // still only the first event

    await transport.close()
    await k.stop()
  })
})
