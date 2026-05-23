import { describe, it, expect } from 'bun:test'
import { createKernel } from '../../src/kernel/kernel'
import { defineExtension } from '../../src/kernel/define-extension'

describe('Kernel', () => {
  it('should create kernel with agentId', () => {
    const k = createKernel({ agentId: 'test' })
    expect(k.ctx.agentId).toBe('test')
  })

  it('should support chainable .use()', async () => {
    const calls: string[] = []
    const ext = defineExtension({
      name: 'test-ext',
      apply: () => ({
        hooks: {
          kernelReady: () => {
            calls.push('ready')
          },
        },
      }),
    })
    const k = createKernel({ agentId: 'test' })
    k.use(ext)
    await k.start()
    expect(calls).toEqual(['ready'])
  })

  it('should start extensions in correct topological order', async () => {
    const order: string[] = []
    const a = defineExtension({
      name: 'a',
      enforce: 'pre',
      apply: () => {
        order.push('a')
        return {}
      },
    })
    const b = defineExtension({
      name: 'b',
      dependsOn: ['a'],
      apply: () => {
        order.push('b')
        return {}
      },
    })
    const k = createKernel({ agentId: 'test' })
    k.use(b).use(a)
    await k.start()
    expect(order).toEqual(['a', 'b'])
  })

  it('should stop kernel and call dispose hooks', async () => {
    let disposed = false
    const ext = defineExtension({
      name: 'disposable',
      apply: () => ({
        dispose: () => {
          disposed = true
        },
      }),
    })
    const k = createKernel({ agentId: 'test' })
    k.use(ext)
    await k.start()
    expect(disposed).toBe(false)
    await k.stop()
    expect(disposed).toBe(true)
  })

  it('should prevent use() after start()', async () => {
    const k = createKernel({ agentId: 'test' })
    k.use(defineExtension({ name: 'x', apply: () => ({}) }))
    await k.start()
    expect(() =>
      k.use(defineExtension({ name: 'y', apply: () => ({}) })),
    ).toThrow('Cannot add extensions after kernel has started')
  })

  it('should handle double start/stop gracefully', async () => {
    const k = createKernel({ agentId: 'test' })
    k.use(defineExtension({ name: 'x', apply: () => ({}) }))
    await k.start()
    await k.start() // noop
    await k.stop()
    await k.stop() // noop
  })

  it('should register and expose capabilities', async () => {
    const ext = defineExtension({
      name: 'provider',
      apply: () => ({
        provide: {
          llm: () => ({ stream: () => 'hello' }),
        },
      }),
    })
    const k = createKernel({ agentId: 'test' })
    k.use(ext)
    await k.start()
    const chat = k.ctx.extensions.get<{ stream: () => string }>('provider.llm')
    expect(chat.stream()).toBe('hello')
  })

  it('should throw CapabilityNotFound for missing capability', async () => {
    const k = createKernel({ agentId: 'test' })
    await k.start()
    expect(() => k.ctx.extensions.get('missing.cap')).toThrow()
  })
})
