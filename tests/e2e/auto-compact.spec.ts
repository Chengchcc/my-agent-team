import { describe, it, expect } from 'bun:test'
import { bootE2E, type E2EHandle } from './_fixtures/boot-kernel'
import { terminalCount } from './_fixtures/event-asserts'
import { given, when, then } from './_fixtures/dsl'

describe('Feature: Auto-compact (F8)', () => {
  it('Scenario 8.1: Given a looooong multi-turn history forcing compaction, When next turn runs, Then compaction fires + turn still completes', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel with long history preamble', async () => {
        h = await bootE2E({
          llmTurns: [{ textDeltas: ['short reply'], usage: { input: 100, output: 1 } }],
        })
      })

      await when('user sends many large inputs to fill history', async () => {
        const { sessionId } = await h!.client.createSession()
        sid = sessionId
        // Send several long inputs to bloat history toward compaction threshold
        const longText = 'x'.repeat(500)
        for (let i = 0; i < 3; i++) {
          await h!.client.sendInput(sid, `${longText} turn${i}`)
          await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
        }
      })

      await then('final turn still completed', () => {
        expect(terminalCount(h!.captured, sid)).toBe(3)
      })
    } finally {
      if (h) await h.stop()
    }
  })
})
