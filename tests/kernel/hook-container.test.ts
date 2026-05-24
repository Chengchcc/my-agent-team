import { describe, it, expect } from 'bun:test'
import { HookContainer } from '../../src/kernel/hook-container'
import type { HookHandler, HookHandlerEntry, Enforce } from '../../src/kernel/define-extension'
import type { Logger } from '../../src/application/ports/logger'

function captureLogger(warns: string[]): Logger {
  const noop = () => {}
  return { debug: noop, info: noop, warn: (_t, m, _f) => warns.push(m), error: noop, withTag: () => captureLogger(warns) }
}

describe('HookContainer', () => {
  it('register and dispatch sequential hook: payload transforms through pipeline', async () => {
    const hc = new HookContainer()

    hc.register('ext-a', 'normal', 'transformPrompt', {
      fn: async (prompt: unknown) => `${prompt} + A`,
    })
    hc.register('ext-b', 'normal', 'transformPrompt', {
      fn: async (prompt: unknown) => `${prompt} + B`,
    })

    // transformPrompt is 'sequential' in HOOK_MODES
    const result = await hc.dispatch('transformPrompt', 'hello')
    expect(result).toBe('hello + A + B')
  })

  it('register and dispatch parallel hook: all handlers called', async () => {
    const hc = new HookContainer()
    const calls: string[] = []

    hc.register('ext-a', 'normal', 'kernelReady', {
      fn: async () => { calls.push('a') },
    })
    hc.register('ext-b', 'normal', 'kernelReady', {
      fn: async () => { calls.push('b') },
    })

    // kernelReady is 'parallel' in HOOK_MODES
    const result = await hc.dispatch('kernelReady')
    expect(result).toBeUndefined()
    expect(calls).toContain('a')
    expect(calls).toContain('b')
    expect(calls.length).toBe(2)
  })

  it('parallel hook failure isolated, other handlers still run', async () => {
    const hc = new HookContainer()
    const warns: string[] = []
    hc.setLogger(captureLogger(warns))
    const calls: string[] = []

    hc.register('ext-a', 'normal', 'kernelReady', {
      fn: async () => { throw new Error('ext-a failed') },
    })
    hc.register('ext-b', 'normal', 'kernelReady', {
      fn: async () => { calls.push('b') },
    })

    // Should not throw
    const result = await hc.dispatch('kernelReady')
    expect(result).toBeUndefined()
    expect(calls).toEqual(['b'])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('ext-a failed')
  })

  it('first-match returns first non-null/undefined result', async () => {
    const hc = new HookContainer()

    hc.register('ext-a', 'normal', 'serveControlMethod', {
      fn: async () => undefined,
    })
    hc.register('ext-b', 'normal', 'serveControlMethod', {
      fn: async () => 'matched-by-b',
    })
    hc.register('ext-c', 'normal', 'serveControlMethod', {
      fn: async () => 'matched-by-c',
    })

    // serveControlMethod is 'first-match' in HOOK_MODES
    const result = await hc.dispatch('serveControlMethod', 'some-method')
    expect(result).toBe('matched-by-b')
  })

  it('first-match returns undefined when no handler matches', async () => {
    const hc = new HookContainer()

    hc.register('ext-a', 'normal', 'serveControlMethod', {
      fn: async () => null, // null counts as "no match"
    })

    const result = await hc.dispatch('serveControlMethod', 'some-method')
    expect(result).toBeUndefined()
  })

  it('enforce order: pre handlers before normal before post', async () => {
    const hc = new HookContainer()
    const order: string[] = []

    hc.register('ext-post', 'post', 'onShutdown', {
      fn: async () => { order.push('post') },
    })
    hc.register('ext-pre', 'pre', 'onShutdown', {
      fn: async () => { order.push('pre') },
    })
    hc.register('ext-normal', 'normal', 'onShutdown', {
      fn: async () => { order.push('normal') },
    })

    // onShutdown is 'sequential'
    await hc.dispatch('onShutdown')
    expect(order).toEqual(['pre', 'normal', 'post'])
  })

  it('order field: lower order runs first within same enforce', async () => {
    const hc = new HookContainer()
    const order: string[] = []

    hc.register('ext-1', 'normal', 'transformPrompt', {
      fn: async (prompt: unknown) => { order.push('b'); return prompt },
      order: 10,
    })
    hc.register('ext-2', 'normal', 'transformPrompt', {
      fn: async (prompt: unknown) => { order.push('a'); return prompt },
      order: 5,
    })

    await hc.dispatch('transformPrompt', 'test')
    expect(order).toEqual(['a', 'b'])
  })

  it('unregisterExtension removes all handlers for that extension', async () => {
    const hc = new HookContainer()
    const calls: string[] = []

    hc.register('ext-a', 'normal', 'kernelReady', {
      fn: async () => { calls.push('a') },
    })
    hc.register('ext-b', 'normal', 'kernelReady', {
      fn: async () => { calls.push('b') },
    })

    hc.unregisterExtension('ext-a')

    await hc.dispatch('kernelReady')
    expect(calls).toEqual(['b'])
  })

  it('hasHandlers / handlerCount correct', () => {
    const hc = new HookContainer()

    expect(hc.hasHandlers('kernelReady')).toBe(false)
    expect(hc.handlerCount('kernelReady')).toBe(0)

    hc.register('ext-a', 'normal', 'kernelReady', { fn: async () => {} })

    expect(hc.hasHandlers('kernelReady')).toBe(true)
    expect(hc.handlerCount('kernelReady')).toBe(1)
  })

  it('clear removes everything', async () => {
    const hc = new HookContainer()
    const calls: string[] = []

    hc.register('ext-a', 'normal', 'kernelReady', {
      fn: async () => { calls.push('a') },
    })
    hc.register('ext-b', 'normal', 'transformPrompt', {
      fn: async (p: unknown) => `${p} + b`,
    })

    hc.clear()

    expect(hc.hasHandlers('kernelReady')).toBe(false)
    expect(hc.hasHandlers('transformPrompt')).toBe(false)

    const result = await hc.dispatch('transformPrompt', 'hello')
    expect(result).toBe('hello')
    expect(calls).toEqual([])
  })

  it('unknown hook defaults to parallel mode', async () => {
    const hc = new HookContainer()
    const calls: string[] = []

    hc.register('ext-a', 'normal', 'unknownHook', {
      fn: async () => { calls.push('a') },
    })
    hc.register('ext-b', 'normal', 'unknownHook', {
      fn: async () => { calls.push('b') },
    })

    const result = await hc.dispatch('unknownHook')
    // Defaults to parallel, so returns undefined
    expect(result).toBeUndefined()
    expect(calls).toContain('a')
    expect(calls).toContain('b')
    expect(calls.length).toBe(2)
  })

  // ── DESIGN.md gap #4: parallel sync throw, first-match null continuation ──

  it('parallel hook: synchronous throw is isolated, other handlers still run', async () => {
    const hc = new HookContainer()
    const warns: string[] = []
    hc.setLogger(captureLogger(warns))
    const calls: string[] = []

    hc.register('ext-a', 'normal', 'kernelReady', {
      // synchronous throw — not an async function
      fn: () => { calls.push('a'); throw new Error('sync fail') },
    })
    hc.register('ext-b', 'normal', 'kernelReady', {
      fn: async () => { calls.push('b') },
    })

    const result = await hc.dispatch('kernelReady')
    expect(result).toBeUndefined()
    // ext-b should still run even though ext-a threw synchronously
    expect(calls).toContain('b')
  })

  it('first-match: null result continues to next handler', async () => {
    const hc = new HookContainer()

    hc.register('ext-a', 'normal', 'serveControlMethod', {
      fn: async () => null,
    })
    hc.register('ext-b', 'normal', 'serveControlMethod', {
      fn: async () => 'found',
    })

    const result = await hc.dispatch('serveControlMethod', 'req')
    expect(result).toBe('found')
  })

  it('sequential hook with no handlers returns first arg unchanged', async () => {
    const hc = new HookContainer()
    const result = await hc.dispatch('transformPrompt', 'unchanged')
    expect(result).toBe('unchanged')
  })
})
