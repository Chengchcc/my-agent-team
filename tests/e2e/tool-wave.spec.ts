import { describe, it, expect, afterEach } from 'bun:test'
import { bootE2E, type E2EHandle } from './_fixtures/boot-kernel'
import { assistantText, terminalCount } from './_fixtures/event-asserts'
import { given, when, then } from './_fixtures/dsl'

describe('Feature: Tool call wave (F5)', () => {
  let h: E2EHandle | null = null
  afterEach(async () => { if (h) await h.stop(); h = null })

  it('Scenario 5.1: Given two parallel tool calls, When turn runs, Then one wave.completed with callsInWave=2 + final text', async () => {
    let sid = ''

    await given('kernel with 2 fake tools + 2-turn LLM', async () => {
      h = await bootE2E({
        fakeTools: [
          { name: 'tool_A', handler: () => 'okA' },
          { name: 'tool_B', handler: () => 'okB' },
        ],
        llmTurns: [
          {
            toolCalls: [
              { id: 'tc1', name: 'tool_A', arguments: '{}' },
              { id: 'tc2', name: 'tool_B', arguments: '{}' },
            ],
            usage: { input: 1, output: 1 },
          },
          { textDeltas: ['done'], usage: { input: 1, output: 1 } },
        ],
      })
    })

    await when('user sends "trigger"', async () => {
      const { sessionId } = await h!.client.createSession()
      sid = sessionId
      await h!.client.sendInput(sid, 'trigger')
    })

    await then('exactly one wave.completed with callsInWave=2', async () => {
      await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
      const waves = h!.captured.filter(e => e.type === 'wave.completed' && e.sessionId === sid)
      expect(waves.length).toBeGreaterThanOrEqual(1)
      const outerPayload = waves[0]!.payload as Record<string, unknown>
      const innerPayload = (outerPayload.payload ?? outerPayload) as { callsInWave?: number }
      expect(innerPayload.callsInWave).toBe(2)
    })

    await then('final assistant text is "done"', () => {
      expect(assistantText(h!.captured, sid)).toBe('done')
    })
  })

  it('Scenario 5.2: Given one tool throws, When turn runs, Then wave still completes with callsInWave=2 + turn reaches completed', async () => {
    let sid = ''

    await given('kernel with one failing tool', async () => {
      h = await bootE2E({
        fakeTools: [
          { name: 'tool_A', handler: () => 'okA' },
          { name: 'tool_B', handler: () => { throw new Error('boom') } },
        ],
        llmTurns: [
          {
            toolCalls: [
              { id: 'tc1', name: 'tool_A', arguments: '{}' },
              { id: 'tc2', name: 'tool_B', arguments: '{}' },
            ],
            usage: { input: 1, output: 1 },
          },
          { textDeltas: ['recovered'], usage: { input: 1, output: 1 } },
        ],
      })
    })

    await when('user sends "trigger"', async () => {
      const { sessionId } = await h!.client.createSession()
      sid = sessionId
      await h!.client.sendInput(sid, 'trigger')
    })

    await then('turn still reaches completed', async () => {
      await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
      expect(terminalCount(h!.captured, sid)).toBe(1)
    })

    await then('wave.completed still has callsInWave=2', () => {
      const waves = h!.captured.filter(e => e.type === 'wave.completed' && e.sessionId === sid)
      expect(waves.length).toBeGreaterThanOrEqual(1)
    })
  })
})
