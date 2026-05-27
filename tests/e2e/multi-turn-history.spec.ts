import { describe, it, expect } from 'bun:test'
import { bootE2E, type E2EHandle } from './_fixtures/boot-kernel'

describe('Feature: Multi-turn history (F4)', () => {
  it('Scenario 4.1: Given two preset turns, When user sends two messages, Then second request includes first message', async () => {
    let h: E2EHandle | null = null
    try {
      h = await bootE2E({
        llmTurns: [
          { textDeltas: ['ack1'], usage: { input: 1, output: 1 } },
          { textDeltas: ['ack2'], usage: { input: 1, output: 1 } },
        ],
      })
      const { sessionId } = await h.client.createSession('e2e-f4')
      const sid = sessionId

      // First turn
      await h.client.sendInput(sid, 'my name is alice')
      await h.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)

      // Second turn
      await h.client.sendInput(sid, 'what is my name?')
      await h.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)

      // Verify both requests were sent
      expect(h.fakeLLM.receivedRequests.length).toBeGreaterThanOrEqual(2)
      // First request contains the first message
      expect(JSON.stringify(h.fakeLLM.receivedRequests[0]?.messages ?? [])).toContain('my name is alice')
      // Second request contains both messages (history carried forward)
      expect(JSON.stringify(h.fakeLLM.receivedRequests[1]?.messages ?? [])).toContain('my name is alice')
      expect(JSON.stringify(h.fakeLLM.receivedRequests[1]?.messages ?? [])).toContain('what is my name?')
    } finally {
      if (h) await h.stop()
    }
  })
})
