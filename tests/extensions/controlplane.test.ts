import { describe, it, expect } from 'bun:test'
import { createTestKernel } from '../helpers/kernel-helper'
import { defineExtension } from '../../src/kernel/define-extension'
import controlplaneExt from '../../src/extensions/controlplane'

interface ControlPlaneServer {
  handle: (message: unknown) => Promise<Record<string, unknown> | null>
  attachFrontend: (frontendId: string, sessionId: string) => void
  detachFrontend: (frontendId: string, sessionId: string) => void
  getFrontendSessions: (frontendId: string) => string[]
}

describe('controlplane extension', () => {
  it('controlplane.server capability should be available', async () => {
    const k = createTestKernel({ extensions: [controlplaneExt()] })
    await k.start()

    const server = k.ctx.extensions.get('controlplane.server')
    expect(server).toBeDefined()
    expect(typeof server.handle).toBe('function')
    expect(typeof server.attachFrontend).toBe('function')
    expect(typeof server.detachFrontend).toBe('function')
    expect(typeof server.getFrontendSessions).toBe('function')

    await k.stop()
  })

  it('hello method should return daemonVersion + agentId', async () => {
    const k = createTestKernel({
      agentId: 'cp-test',
      extensions: [controlplaneExt()],
    })
    await k.start()

    const server = k.ctx.extensions.get('controlplane.server')

    const result = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'hello',
    })

    expect(result).not.toBeNull()
    expect(result!.result).toBeDefined()
    const r = result!.result as Record<string, unknown>
    expect(r.daemonVersion).toBe('2.0.0')
    expect(r.agentId).toBe('cp-test')
    expect(r.capabilities).toBeDefined()
    expect(typeof (r.capabilities as Record<string, unknown>).events).toBe('number')
    expect((r.capabilities as Record<string, unknown>).methods).toBe(k.ctx.rpc.listMethods().length)

    await k.stop()
  })

  it('unknown method should return METHOD_NOT_FOUND (-32601)', async () => {
    const k = createTestKernel({ extensions: [controlplaneExt()] })
    await k.start()

    const server = k.ctx.extensions.get('controlplane.server')

    const result = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'nonexistent.method',
    })

    expect(result).not.toBeNull()
    expect(result!.error).toBeDefined()
    const err = result!.error as { code: number; message: string }
    expect(err.code).toBe(-32601)
    expect(err.message).toBe('Method not found')

    await k.stop()
  })

  it('should route to serveControlMethod hook — first-match via fake extension with RPC', async () => {
    // Create a fake extension that registers an RPC handler
    const fakeRpcExt = () =>
      defineExtension({
        name: 'fakeRpc',
        enforce: 'normal',
        apply: () => ({
          rpc: {
            'fake.echo': (params: unknown) => {
              const p = params as Record<string, unknown>
              return { echoed: p.message }
            },
          },
        }),
      })

    const k = createTestKernel({
      extensions: [fakeRpcExt(), controlplaneExt()],
    })
    await k.start()

    const server = k.ctx.extensions.get('controlplane.server')

    const result = await server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'fake.echo',
      params: { message: 'hello world' },
    })

    expect(result).not.toBeNull()
    expect(result!.result).toBeDefined()
    const r = result!.result as Record<string, unknown>
    expect(r.echoed).toBe('hello world')

    await k.stop()
  })

  it('notification (no id) should not return a response', async () => {
    const k = createTestKernel({ extensions: [controlplaneExt()] })
    await k.start()

    const server = k.ctx.extensions.get('controlplane.server')

    const result = await server.handle({
      jsonrpc: '2.0',
      method: 'hello',
    })

    // hello with no id is a notification — no response
    expect(result).toBeNull()

    await k.stop()
  })

  it('should track frontend attach/detach and emit bus events', async () => {
    const k = createTestKernel({ extensions: [controlplaneExt()] })
    await k.start()

    const server = k.ctx.extensions.get('controlplane.server')

    const attachedEvents: unknown[] = []
    const detachedEvents: unknown[] = []

    k.ctx.bus.on('frontend.attached', (payload) => {
      attachedEvents.push(payload)
    })
    k.ctx.bus.on('frontend.detached', (payload) => {
      detachedEvents.push(payload)
    })

    server.attachFrontend('fe-1', 'session-a')
    server.attachFrontend('fe-1', 'session-b')
    server.attachFrontend('fe-2', 'session-c')

    expect(server.getFrontendSessions('fe-1')).toEqual(['session-a', 'session-b'])
    expect(server.getFrontendSessions('fe-2')).toEqual(['session-c'])
    expect(server.getFrontendSessions('fe-unknown')).toEqual([])

    // Bus events should have been emitted
    expect(attachedEvents).toHaveLength(3)
    expect(attachedEvents[0]).toMatchObject({
      frontendId: 'fe-1',
      sessionId: 'session-a',
    })

    // Detach one
    server.detachFrontend('fe-1', 'session-a')
    expect(server.getFrontendSessions('fe-1')).toEqual(['session-b'])
    expect(detachedEvents).toHaveLength(1)
    expect(detachedEvents[0]).toMatchObject({
      frontendId: 'fe-1',
      sessionId: 'session-a',
    })

    await k.stop()
  })
})
