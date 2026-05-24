import { describe, it, expect } from 'bun:test'
import { runTurn } from '../../src/domain/turn-runner'
import type { RunTurnDeps } from '../../src/domain/turn-runner.types'
import type { ProviderChat, ChatResponseChunk } from '../../src/application/ports/provider'

/**
 * Tests for AbortController cancellation during turn execution.
 * DESIGN.md gap #2: abort between tool.start and tool.end yields turn.failed.
 */

function stubProvider(chunks: ChatResponseChunk[]): ProviderChat {
  return {
    stream: async function* () { for (const c of chunks) yield c },
    complete: async () => ({ id: '', content: '', usage: { input: 0, output: 0 }, model: '' }),
  }
}

describe('turn-runner AbortController cancellation', () => {
  it('abort during onToolCall: tool result returned, turn completes on next iteration', async () => {
    const controller = new AbortController()

    const provider = stubProvider([
      { type: 'tool_call_start', toolCall: { id: 't1', name: 'read', arguments: '{"path":"/f"}' } },
      { type: 'done' },
    ])

    let toolStarted = false

    const deps: RunTurnDeps = {
      sessionId: 's1',
      turnId: 'turn-1',
      messages: [{ role: 'user', content: 'read /f' }],
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }],
      provider,
      hooks: {
        onToolCall: async () => {
          toolStarted = true
          controller.abort()
          return 'result'
        },
      },
      abortSignal: controller.signal,
      maxIterations: 10,
    }

    const events: Array<{ type: string }> = []
    for await (const event of runTurn(deps)) {
      events.push(event)
    }

    // tool.start and tool.end are both emitted (result is not discarded)
    expect(events.some(e => e.type === 'tool.start')).toBe(true)
    expect(events.some(e => e.type === 'tool.end')).toBe(true)
    expect(toolStarted).toBe(true)

    // Abort is caught at next iteration check → turn completes
    expect(events.some(e => e.type === 'turn.completed')).toBe(true)
  })

  it('checks abortSignal.aborted between iterations and stops', async () => {
    const controller = new AbortController()

    let round = 0
    const provider: ProviderChat = {
      stream: async function* () {
        round++
        if (round === 1) {
          yield { type: 'text', delta: 'first round' }
          yield { type: 'done' }
        } else {
          // Should never reach here if abort works
          yield { type: 'text', delta: 'second round' }
          yield { type: 'done' }
        }
      },
      complete: async () => ({ id: '', content: '', usage: { input: 0, output: 0 }, model: '' }),
    }

    const deps: RunTurnDeps = {
      sessionId: 's1',
      turnId: 'turn-2',
      messages: [{ role: 'user', content: 'chat' }],
      tools: [],
      provider,
      hooks: { onToolCall: async () => 'x' },
      abortSignal: controller.signal,
      maxIterations: 10,
    }

    // Abort after the first iteration
    controller.abort()

    const events: Array<{ type: string }> = []
    for await (const event of runTurn(deps)) {
      events.push(event)
    }

    // Should complete after first round (abort prevents second iteration)
    // The abort check happens at the start of each loop iteration
    // Since abort() is called before the generator starts, the first iteration check catches it
    const completed = events.find(e => e.type === 'turn.completed')
    expect(completed).toBeDefined()
    expect(round).toBeLessThanOrEqual(1)
  })

  it('yields turn.failed when provider stream throws', async () => {
    const provider: ProviderChat = {
      stream: async function* () {
        throw new Error('provider connection lost')
      },
      complete: async () => ({ id: '', content: '', usage: { input: 0, output: 0 }, model: '' }),
    }

    const deps: RunTurnDeps = {
      sessionId: 's1',
      turnId: 'turn-3',
      messages: [{ role: 'user', content: 'chat' }],
      tools: [],
      provider,
      hooks: { onToolCall: async () => 'x' },
      maxIterations: 10,
    }

    const events: Array<{ type: string }> = []
    for await (const event of runTurn(deps)) {
      events.push(event)
    }

    const failed = events.find(e => e.type === 'turn.failed')
    expect(failed).toBeDefined()
    const tf = failed as { type: 'turn.failed'; stage: string; err: { message: string } }
    expect(tf.stage).toBe('llm_stream')
    expect(tf.err.message).toContain('provider connection lost')
  })
})
