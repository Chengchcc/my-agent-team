import { describe, it, expect, mock } from 'bun:test'
import { SubAgentRegistry, registerBuiltins } from '../../../src/extensions/sub-agent/registry'

let createSpawnerSubAgentRunner: any
try {
  createSpawnerSubAgentRunner = require('../../../src/extensions/sub-agent/runner-spawner').createSpawnerSubAgentRunner
} catch {
  // Not yet created
}

function makeDeps(overrides?: Record<string, unknown>) {
  const registry = new SubAgentRegistry()
  registerBuiltins(registry)

  return {
    spawner: { run: mock(async () => ({ finalText: 'result', usage: { input: 10, output: 5 }, toolCallCount: 0, rounds: 1 })) },
    registry,
    toolCatalog: {
      get: mock((name: string) => name === 'read' ? {
        name: 'read', description: 'read file', parameters: {},
        execute: mock(async () => 'content'), parse: mock((args: unknown) => args),
      } : undefined),
    },
    chatComplete: mock(async () => ({ content: 'ok', usage: { input: 5, output: 3 }, finishReason: 'stop' })),
    bus: { emit: mock(() => {}) },
    logger: { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}), debug: mock(() => {}), withTag: mock(() => ({})) },
    agentDir: '/tmp/test-agent',
    ...overrides,
  }
}

describe('createSpawnerSubAgentRunner', () => {
  it('returns result from spawned worker', async () => {
    const deps = makeDeps()
    const runner = createSpawnerSubAgentRunner(deps)
    const result = await runner({
      type: 'explore',
      prompt: 'find X',
      parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1',
      parentSignal: new AbortController().signal,
    })
    expect(result).toBe('result')
  })

  it('returns unknown_subagent_type for unregistered type', async () => {
    const deps = makeDeps()
    const runner = createSpawnerSubAgentRunner(deps)
    const result = await runner({
      type: 'nonexistent',
      prompt: 'test',
      parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1',
      parentSignal: new AbortController().signal,
    })
    expect(result).toContain('unknown_subagent_type')
    expect(result).toContain('nonexistent')
  })

  it('generates unique calls per parallel run (3 concurrent)', async () => {
    const deps = makeDeps()
    const runner = createSpawnerSubAgentRunner(deps)
    const signal = new AbortController().signal

    const results = await Promise.all([
      runner({ type: 'explore', prompt: 'a', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1', parentSignal: signal }),
      runner({ type: 'plan', prompt: 'b', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c2', parentSignal: signal }),
      runner({ type: 'explore', prompt: 'c', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c3', parentSignal: signal }),
    ])

    expect(results.every(r => r === 'result')).toBe(true)
    // spawner.run called 3 times
    expect((deps.spawner as any).run).toHaveBeenCalledTimes(3)
  })

  it('returns cancelled on AbortError', async () => {
    const deps = makeDeps()
    ;(deps.spawner as any).run = mock(async () => {
      const err = new Error('aborted')
      ;(err as any).name = 'AbortError'
      throw err
    })
    const runner = createSpawnerSubAgentRunner(deps)
    const result = await runner({
      type: 'explore', prompt: 'test',
      parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1',
      parentSignal: new AbortController().signal,
    })
    expect(result).toContain('cancelled')
  })

  it('returns failed on worker crash', async () => {
    const deps = makeDeps()
    ;(deps.spawner as any).run = mock(async () => {
      throw new Error('worker exited code=1')
    })
    const runner = createSpawnerSubAgentRunner(deps)
    const result = await runner({
      type: 'explore', prompt: 'test',
      parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1',
      parentSignal: new AbortController().signal,
    })
    expect(result).toContain('failed')
    expect(result).toContain('worker exited')
  })

  it('returns busy when concurrency cap is hit', async () => {
    const deps = makeDeps()
    // Make spawner.run hang indefinitely
    ;(deps.spawner as any).run = mock(() => new Promise(() => {}))
    const runner = createSpawnerSubAgentRunner(deps)
    const signal = new AbortController().signal

    // Launch 3 that will hang (fill the cap)
    const p1 = runner({ type: 'explore', prompt: '1', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1', parentSignal: signal })
    const p2 = runner({ type: 'plan', prompt: '2', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c2', parentSignal: signal })
    const p3 = runner({ type: 'explore', prompt: '3', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c3', parentSignal: signal })

    // Small delay to let semaphore register the 3
    await new Promise(r => setTimeout(r, 5))

    // 4th should return busy immediately (doesn't block)
    const fourth = await runner({ type: 'explore', prompt: '4', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c4', parentSignal: signal })
    expect(fourth).toContain('busy')
  })
})
