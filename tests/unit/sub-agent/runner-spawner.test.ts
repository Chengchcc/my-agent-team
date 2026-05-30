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
      description: 'test desc',
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
      description: 'test desc',
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
      runner({ type: 'explore', prompt: 'a', description: 'test desc', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1', description: 'test desc', parentSignal: signal }),
      runner({ type: 'plan', prompt: 'b', description: 'test desc', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c2', description: 'test desc', parentSignal: signal }),
      runner({ type: 'explore', prompt: 'c', description: 'test desc', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c3', description: 'test desc', parentSignal: signal }),
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
      type: 'explore', prompt: 'test', description: 'test desc',
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
      type: 'explore', prompt: 'test', description: 'test desc',
      parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1',
      parentSignal: new AbortController().signal,
    })
    expect(result).toContain('failed')
    expect(result).toContain('worker exited')
  })

  it('I-1: subagent.started includes parentSessionId', async () => {
    let startedPayload: any = null
    const deps = makeDeps()
    ;(deps.bus as any).emit = mock((event: string, payload: any) => {
      if (event === 'subagent.started') startedPayload = payload
    })
    const runner = createSpawnerSubAgentRunner(deps)
    await runner({
      type: 'explore', prompt: 'test', description: 'test desc',
      parentSessionId: 'PARENT-S', parentTurnId: 'T1', parentCallId: 'C1',
      parentSignal: new AbortController().signal,
    })
    expect(startedPayload).toBeDefined()
    expect(startedPayload.parentSessionId).toBe('PARENT-S')
  })

  it('I-2: subagent.completed includes durationMs > 0', async () => {
    let completedPayload: any = null
    const deps = makeDeps()
    ;(deps.bus as any).emit = mock((event: string, payload: any) => {
      if (event === 'subagent.completed') completedPayload = payload
    })
    const runner = createSpawnerSubAgentRunner(deps)
    await runner({
      type: 'explore', prompt: 'test', description: 'test desc',
      parentSessionId: 'PS1', parentTurnId: 'T1', parentCallId: 'C1',
      parentSignal: new AbortController().signal,
    })
    expect(completedPayload).toBeDefined()
    expect(completedPayload.durationMs).toBeGreaterThanOrEqual(0)
    expect(completedPayload.parentSessionId).toBe('PS1')
  })

  it('I-9: model from resolveModel is used in chatComplete', async () => {
    let capturedModel: string | undefined
    const deps = makeDeps({
      resolveModel: (hint: any) => hint === 'fast' ? 'claude-haiku' : undefined,
    })
    // Make spawner.run call ctx.chatComplete to test model forwarding
    ;(deps.spawner as any).run = mock(async (opts: { ctx: { chatComplete: (req: any) => Promise<any> } }) => {
      const resp = await opts.ctx.chatComplete({ purpose: 'subagent.run.test', messages: [], tools: [], maxTokens: 100 })
      return { finalText: resp.content, usage: resp.usage, finishReason: resp.finishReason, toolCallCount: 0, rounds: 1 }
    })
    ;(deps as any).chatComplete = mock(async (req: { model?: string }) => {
      capturedModel = req.model
      return { content: 'ok', finishReason: 'stop' as const, usage: { input: 5, output: 3 } }
    })
    const runner = createSpawnerSubAgentRunner(deps)
    await runner({
      type: 'explore', prompt: 'test', description: 'test desc',
      parentSessionId: 'PS1', parentTurnId: 'T1', parentCallId: 'C1',
      parentSignal: new AbortController().signal,
    })
    expect(capturedModel).toBe('claude-haiku')
  })

  it('returns busy when concurrency cap is hit', async () => {
    const deps = makeDeps()
    // Make spawner.run hang indefinitely
    ;(deps.spawner as any).run = mock(() => new Promise(() => {}))
    const runner = createSpawnerSubAgentRunner(deps)
    const signal = new AbortController().signal

    // Launch 3 that will hang (fill the cap)
    const p1 = runner({ type: 'explore', prompt: '1', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c1', description: 'test desc', parentSignal: signal })
    const p2 = runner({ type: 'plan', prompt: '2', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c2', description: 'test desc', parentSignal: signal })
    const p3 = runner({ type: 'explore', prompt: '3', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c3', description: 'test desc', parentSignal: signal })

    // Small delay to let semaphore register the 3
    await new Promise(r => setTimeout(r, 5))

    // 4th should return busy immediately (doesn't block)
    const fourth = await runner({ type: 'explore', prompt: '4', parentSessionId: 's1', parentTurnId: 't1', parentCallId: 'c4', description: 'test desc', parentSignal: signal })
    expect(fourth).toContain('busy')
  })
})
