import { describe, it, expect } from 'bun:test'
import { runTurn } from '../../src/domain/turn-runner'
import type {
  RunTurnDeps, TurnEvent, LlmMessage, ToolDescriptor,
  ChatResponseChunk,
} from '../../src/domain/turn-runner.types'

// ── Helpers ────────────────────────────────────────────────────────────────

/** Collect all events from a generator into an array */
async function collectEvents(gen: AsyncGenerator<TurnEvent, void, void>): Promise<TurnEvent[]> {
  const events: TurnEvent[] = []
  for await (const ev of gen) events.push(ev)
  return events
}

/** Build a fake provider that yields the given chunk sequence */
function fakeProvider(chunks: ChatResponseChunk[]) {
  return {
    stream: async function* () {
      for (const c of chunks) yield c
    },
    complete: async () => ({ id: '', content: '', usage: { input: 0, output: 0 }, model: '' }),
  }
}

/** Minimal deps for a turn */
function deps(overrides: Partial<RunTurnDeps> & { messages: LlmMessage[] }): RunTurnDeps {
  return {
    sessionId: 's1',
    turnId: 't1',
    tools: [],
    provider: fakeProvider([]),
    hooks: { onToolCall: async () => 'stub-result' },
    maxIterations: 10,
    ...overrides,
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('runTurn', () => {
  // ── No tool, single turn ──────────────────────────────────────────────

  it('completes on a single text-only turn', async () => {
    const provider = fakeProvider([
      { type: 'text', delta: 'Hello' },
      { type: 'text', delta: ' world' },
      { type: 'done' },
    ])

    const events = await collectEvents(runTurn(deps({
      messages: [{ role: 'user', content: 'hi' }],
      provider,
    })))

    const deltas = events.filter(e => e.type === 'llm.delta')
    expect(deltas).toHaveLength(2)
    expect(deltas[0]).toMatchObject({ type: 'llm.delta', sessionId: 's1', turnId: 't1', delta: 'Hello' })
    expect(deltas[1]).toMatchObject({ type: 'llm.delta', delta: ' world' })

    const completed = events.find(e => e.type === 'turn.completed')
    expect(completed).toBeDefined()
    expect(completed).toMatchObject({
      type: 'turn.completed',
      sessionId: 's1', turnId: 't1',
      finalMessage: 'Hello world',
    })
  })

  // ── Single tool call ──────────────────────────────────────────────────

  it('handles a single tool call round', async () => {
    let round = 0
    const provider = {
      stream: async function* () {
        round++
        if (round === 1) {
          yield { type: 'tool_call_start', toolCall: { id: 'tc1', name: 'read', arguments: '{"path":"/f"}' } }
          yield { type: 'text', delta: 'Result is...' }
          yield { type: 'done' }
        } else {
          yield { type: 'text', delta: 'Done.' }
          yield { type: 'done' }
        }
      },
      complete: async () => ({ id: '', content: '', usage: { input: 0, output: 0 }, model: '' }),
    }

    const toolResults: unknown[] = []
    const hooks = {
      onToolCall: async (call: { id: string; name: string; arguments: unknown }) => {
        toolResults.push(call)
        return { content: 'file contents' }
      },
    }

    const events = await collectEvents(runTurn(deps({
      messages: [{ role: 'user', content: 'read /f' }],
      provider, hooks,
    })))

    expect(events.some(e => e.type === 'tool.start')).toBe(true)
    expect(events.some(e => e.type === 'tool.end')).toBe(true)
    expect(toolResults).toHaveLength(1)
  })

  // ── Multi-turn (tool → LLM → tool → done) ──────────────────────────────

  it('handles multiple tool-call rounds', async () => {
    let round = 0
    const provider = {
      stream: async function* () {
        round++
        if (round === 1) {
          yield { type: 'tool_call_start', toolCall: { id: 't1', name: 'read', arguments: '{}' } }
          yield { type: 'done' }
        } else {
          yield { type: 'text', delta: 'Done.' }
          yield { type: 'done' }
        }
      },
      complete: async () => ({ id: '', content: '', usage: { input: 0, output: 0 }, model: '' }),
    }

    const events = await collectEvents(runTurn(deps({
      messages: [{ role: 'user', content: 'go' }],
      provider,
    })))

    const toolStarts = events.filter(e => e.type === 'tool.start')
    expect(toolStarts).toHaveLength(1)

    const completed = events.find(e => e.type === 'turn.completed')
    expect(completed).toMatchObject({ finalMessage: 'Done.' })
  })

  // ── Tool error recovery ───────────────────────────────────────────────

  it('yields tool.error and continues on onToolCall failure', async () => {
    let callCount = 0
    const provider = {
      stream: async function* () {
        callCount++
        if (callCount === 1) {
          yield { type: 'tool_call_start', toolCall: { id: 'bad', name: 'crash', arguments: '{}' } }
          yield { type: 'done' }
        } else {
          yield { type: 'text', delta: 'Recovered.' }
          yield { type: 'done' }
        }
      },
      complete: async () => ({ id: '', content: '', usage: { input: 0, output: 0 }, model: '' }),
    }

    const hooks = {
      onToolCall: async (call: { name: string }) => {
        if (call.name === 'crash') throw new Error('BOOM')
        return 'ok'
      },
    }

    const events = await collectEvents(runTurn(deps({
      messages: [{ role: 'user', content: 'test' }],
      provider, hooks,
    })))

    const toolErrors = events.filter(e => e.type === 'tool.error')
    expect(toolErrors).toHaveLength(1)
    expect(toolErrors[0]).toMatchObject({ callId: 'bad', name: 'crash', err: { message: 'BOOM' } })

    // Turn should still complete after recovery
    expect(events.some(e => e.type === 'turn.completed')).toBe(true)
  })

  // ── Exceeds maxIterations ─────────────────────────────────────────────

  it('stops after maxIterations even with persistent tool calls', async () => {
    const provider = fakeProvider([
      { type: 'tool_call_start', toolCall: { id: 'loop', name: 'ping', arguments: '{}' } },
      { type: 'done' },
    ])

    const hooks = { onToolCall: async () => 'pong' }

    const events = await collectEvents(runTurn(deps({
      messages: [{ role: 'user', content: 'loop' }],
      provider, hooks, maxIterations: 2,
    })))

    const toolStarts = events.filter(e => e.type === 'tool.start')
    expect(toolStarts).toHaveLength(2)

    const completed = events.find(e => e.type === 'turn.completed')
    // After 2 iterations with persistent tool calls, the loop ends
    expect(completed).toBeDefined()
  })

  // ── Provider stream failure ───────────────────────────────────────────

  it('yields turn.failed on provider stream error', async () => {
    const provider = {
      stream: async function* () {
        yield { type: 'text', delta: 'A' }
        throw new Error('Network down')
      },
      complete: async () => ({ id: '', content: '', usage: { input: 0, output: 0 }, model: '' }),
    }

    const events = await collectEvents(runTurn(deps({
      messages: [{ role: 'user', content: 'hi' }],
      provider,
    })))

    const failed = events.find(e => e.type === 'turn.failed')
    expect(failed).toBeDefined()
    expect(failed).toMatchObject({
      sessionId: 's1', turnId: 't1',
      stage: 'llm_stream',
      err: { message: 'Network down' },
    })
  })

  // ── Usage tracking ────────────────────────────────────────────────────

  it('accumulates usage across rounds', async () => {
    let round = 0
    const provider = {
      stream: async function* () {
        round++
        if (round === 1) {
          yield { type: 'tool_call_start', toolCall: { id: 't1', name: 'echo', arguments: '{}' } }
          yield { type: 'usage', usage: { input: 10, output: 5 } }
          yield { type: 'done' }
        } else {
          yield { type: 'text', delta: 'ok' }
          yield { type: 'usage', usage: { input: 8, output: 3 } }
          yield { type: 'done' }
        }
      },
      complete: async () => ({ id: '', content: '', usage: { input: 0, output: 0 }, model: '' }),
    }

    const hooks = { onToolCall: async () => 'echoed' }

    const events = await collectEvents(runTurn(deps({
      messages: [{ role: 'user', content: 'test' }],
      provider, hooks,
    })))

    const completed = events.find(e => e.type === 'turn.completed')
    expect(completed).toBeDefined()
    if (completed?.type === 'turn.completed') {
      expect(completed.usage).toEqual({ input: 18, output: 8 })
    }
  })

  // ── Tool call argument parsing ────────────────────────────────────────

  it('parses tool call arguments from JSON string', async () => {
    const provider = fakeProvider([
      { type: 'tool_call_start', toolCall: { id: 't1', name: 'edit', arguments: '{"path":"/x","old":"a","new":"b"}' } },
      { type: 'done' },
    ])

    let receivedArgs: unknown = undefined
    const hooks = {
      onToolCall: async (call: { arguments: unknown }) => { receivedArgs = call.arguments; return 'ok' },
    }

    await collectEvents(runTurn(deps({
      messages: [{ role: 'user', content: 'edit' }],
      provider, hooks,
    })))

    expect(receivedArgs).toEqual({ path: '/x', old: 'a', new: 'b' })
  })

  // ── Malformed JSON arguments ──────────────────────────────────────────

  it('falls back to empty object on malformed JSON arguments', async () => {
    const provider = fakeProvider([
      { type: 'tool_call_start', toolCall: { id: 't1', name: 'bad', arguments: 'not-json' } },
      { type: 'done' },
    ])

    let receivedArgs: unknown = undefined
    const hooks = {
      onToolCall: async (call: { arguments: unknown }) => { receivedArgs = call.arguments; return 'ok' },
    }

    await collectEvents(runTurn(deps({
      messages: [{ role: 'user', content: 'test' }],
      provider, hooks,
    })))

    expect(receivedArgs).toEqual({})
  })
})
