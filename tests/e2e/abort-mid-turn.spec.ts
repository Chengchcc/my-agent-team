import { describe, it, expect } from 'bun:test'
import { bootE2E, type E2EHandle } from './_fixtures/boot-kernel'
import { terminalCount } from './_fixtures/event-asserts'
import { given, when, then } from './_fixtures/dsl'

describe('Feature: Abort mid-turn (F6)', () => {
  it('Scenario 6.1: Given slow stream, When cancel after 2 deltas, Then turn.failed + provider observes abort', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel with slow 10-delta LLM (10ms per delta)', async () => {
        const deltas = Array.from({ length: 10 }, (_, i) => `chunk${i}`)
        h = await bootE2E({
          llmTurns: [{ textDeltas: deltas, delayMs: 10, usage: { input: 1, output: 10 } }],
        })
      })

      await when('user sends input then cancels', async () => {
        const { sessionId } = await h!.client.createSession()
        sid = sessionId
        await h!.client.sendInput(sid, 'hi')
        // Wait for a few deltas to fire, then cancel
        await new Promise(r => setTimeout(r, 50))
        await h!.client.sendRpc('input.cancel', { sessionId: sid, reason: 'test abort' })
      })

      await then('turn.failed fires within 2s', async () => {
        await h!.waitFor(e => e.type === 'turn.failed' && e.sessionId === sid)
        expect(terminalCount(h!.captured, sid)).toBe(1)
      })
    } finally {
      if (h) await h.stop()
    }
  })
})
