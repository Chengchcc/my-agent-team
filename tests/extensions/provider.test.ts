import { describe, it, expect } from 'bun:test'
import { createTestKernel } from '../helpers/kernel-helper'
import providerExt from '../../src/extensions/provider'
import type { ProviderChat, ProviderInvoke } from '../../src/application/ports/provider'

describe('provider extension', () => {
  it('should expose provider.chat capability after start', async () => {
    const k = createTestKernel({ extensions: [providerExt({})] })
    await k.start()

    const chat = k.ctx.extensions.get<ProviderChat>('provider.llm')
    expect(chat).toBeDefined()
    expect(typeof chat.stream).toBe('function')
    expect(typeof chat.complete).toBe('function')
    await k.stop()
  })

  it('should expose provider.invoke capability after start', async () => {
    const k = createTestKernel({ extensions: [providerExt({})] })
    await k.start()

    const invoke = k.ctx.extensions.get<ProviderInvoke>('provider.llm')
    expect(invoke).toBeDefined()
    expect(typeof invoke.call).toBe('function')
    await k.stop()
  })

  it('should stream echo chunks', async () => {
    const k = createTestKernel({ extensions: [providerExt({})] })
    await k.start()

    const chat = k.ctx.extensions.get<ProviderChat>('provider.llm')
    const chunks: unknown[] = []
    for await (const chunk of chat.stream({
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      chunks.push(chunk)
    }

    expect(chunks).toHaveLength(3)

    // First chunk: text delta
    expect(chunks[0]).toMatchObject({ type: 'text', delta: 'ECHO: hello' })

    // Second chunk: usage
    expect(chunks[1]).toMatchObject({
      type: 'usage',
      usage: { input: 5, output: 11 },
    })

    // Third chunk: done
    expect(chunks[2]).toEqual({ type: 'done' })

    await k.stop()
  })

  it('should emit provider.stream.chunk bus event via onLLMDelta hook', async () => {
    const k = createTestKernel({ extensions: [providerExt({})] })
    await k.start()

    const deltas: unknown[] = []
    k.ctx.bus.on('provider.stream.chunk', (payload) => {
      deltas.push(payload)
    })

    // Simulate dispatching delta chunks (what agent loop would do)
    const chunks = [
      { type: 'text' as const, delta: 'ECHO: test' },
      { type: 'usage' as const, usage: { input: 4, output: 10 } },
    ]

    for (const chunk of chunks) {
      await k.ctx.hooks.dispatch('onLLMDelta', chunk)
    }

    expect(deltas).toHaveLength(2)
    expect(deltas[0]).toMatchObject({ type: 'text', delta: 'ECHO: test' })
    expect(deltas[1]).toMatchObject({ type: 'usage' })
    await k.stop()
  })

  it('should complete() return echo response', async () => {
    const k = createTestKernel({ extensions: [providerExt({})] })
    await k.start()

    const chat = k.ctx.extensions.get<ProviderChat>('provider.llm')
    const response = await chat.complete({
      messages: [{ role: 'user', content: 'test message' }],
    })

    expect(response.content).toBe('ECHO: test message')
    expect(response.usage).toEqual({ input: 12, output: 18 })
    expect(response.model).toBe('echo')
    expect(response.id).toMatch(/^echo-/)
    await k.stop()
  })
})
