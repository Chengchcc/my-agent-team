import { describe, it, expect } from 'bun:test'
import { FakeSubAgentSpawner } from './_fixtures/fake-sub-agent-spawner'
import { SubAgentRegistry, registerBuiltins } from '../../src/extensions/sub-agent/registry'

describe('Sub-agent E2E flows (M2)', () => {
  it('F18.1: task tool discoverable and type enum is dynamic', () => {
    const registry = new SubAgentRegistry()
    registerBuiltins(registry)
    const types = registry.list().map(d => d.type)
    expect(types).toContain('explore')
    expect(types).toContain('plan')
    expect(types).toContain('general-purpose')
    for (const desc of registry.list()) {
      expect(desc.allowedToolNames).not.toContain('task')
    }
  })

  it('F18.2: unknown subagent_type returns structured error', async () => {
    const fakeSpawner = new FakeSubAgentSpawner()
    const { createSpawnerSubAgentRunner } = await import('../../src/extensions/sub-agent/runner-spawner')

    const registry = new SubAgentRegistry()
    registerBuiltins(registry)

    const runner = createSpawnerSubAgentRunner({
      spawner: fakeSpawner,
      registry,
      toolCatalog: { get: () => undefined },
      chatComplete: async () => ({ content: 'ok', usage: { input: 0, output: 0 }, finishReason: 'stop' }),
      bus: { emit: () => {} } as any,
      logger: { info() {}, warn() {}, error() {}, debug() {}, withTag() { return this } } as any,
      agentDir: '/tmp/test',
    })

    const result = await runner({
      type: 'nonexistent',
      prompt: 'test',
      parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1',
      parentSignal: new AbortController().signal,
    })

    expect(result).toContain('unknown_subagent_type')
    expect(result).toContain('nonexistent')
    expect(result).toContain('available=')
  })

  it('F18.3: sub-agent completes and returns result', async () => {
    const fakeSpawner = new FakeSubAgentSpawner(async (_job, _ctx) => {
      return { finalText: 'exploration complete', usage: { input: 10, output: 5 }, toolCallCount: 0, rounds: 1, finishReason: 'stop' }
    })

    const registry = new SubAgentRegistry()
    registerBuiltins(registry)

    const { createSpawnerSubAgentRunner } = await import('../../src/extensions/sub-agent/runner-spawner')
    const runner = createSpawnerSubAgentRunner({
      spawner: fakeSpawner,
      registry,
      toolCatalog: { get: () => undefined },
      chatComplete: async () => ({ content: 'ok', usage: { input: 0, output: 0 }, finishReason: 'stop' }),
      bus: { emit: () => {} } as any,
      logger: { info() {}, warn() {}, error() {}, debug() {}, withTag() { return this } } as any,
      agentDir: '/tmp/test',
    })

    const result = await runner({
      type: 'explore',
      prompt: 'find the config file',
      parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1',
      parentSignal: new AbortController().signal,
    })

    expect(result).toBe('exploration complete')
  })

  it('F18.4: parent abort propagates to sub-agent', async () => {
    const controller = new AbortController()

    const fakeSpawner = new FakeSubAgentSpawner(async (_job, _ctx) => {
      return new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          ;(err as any).name = 'AbortError'
          reject(err)
        })
      })
    })

    const registry = new SubAgentRegistry()
    registerBuiltins(registry)

    const { createSpawnerSubAgentRunner } = await import('../../src/extensions/sub-agent/runner-spawner')
    const runner = createSpawnerSubAgentRunner({
      spawner: fakeSpawner,
      registry,
      toolCatalog: { get: () => undefined },
      chatComplete: async () => ({ content: 'ok', usage: { input: 0, output: 0 }, finishReason: 'stop' }),
      bus: { emit: () => {} } as any,
      logger: { info() {}, warn() {}, error() {}, debug() {}, withTag() { return this } } as any,
      agentDir: '/tmp/test',
    })

    const resultPromise = runner({
      type: 'explore',
      prompt: 'long task',
      parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1',
      parentSignal: controller.signal,
    })

    controller.abort()
    const result = await resultPromise
    expect(result).toContain('cancelled')
  })
})
