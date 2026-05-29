import { describe, it, expect } from 'bun:test'
import { bootE2E, type E2EHandle } from './_fixtures/boot-kernel'
import { terminalCount } from './_fixtures/event-asserts'
import { given, when, then } from './_fixtures/dsl'

describe('Feature: System Prompt Routing (F11)', () => {
  it('Scenario 11.1: systemPrompt arrives at LLM wire with identity content', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel with single-turn LLM', async () => {
        h = await bootE2E({
          llmTurns: [{ textDeltas: ['ok'], usage: { input: 1, output: 1 } }],
        })
      })

      await when('user sends a message', async () => {
        const { sessionId } = await h!.client.createSession()
        sid = sessionId
        await h!.client.sendInput(sid, 'hello')
      })

      await then('turn completes', async () => {
        await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
        expect(terminalCount(h!.captured, sid)).toBe(1)
      })

      await then('systemPrompt is present and non-empty', () => {
        const req = h!.fakeLLM.receivedRequests[0]
        expect(req).toBeDefined()
        expect(req!.systemPrompt).toBeTruthy()
        expect(req!.systemPrompt!.length).toBeGreaterThan(10)
      })

      await then('systemPrompt contains identity', () => {
        const sp = h!.fakeLLM.receivedRequests[0]!.systemPrompt!
        expect(sp).toContain('<identity>')
        expect(sp).toContain('role')
      })
    } finally {
      if (h) await h.stop()
    }
  })

  it('Scenario 11.2: system is NOT embedded in messages (regression for toLlmMessages filter)', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel with single-turn LLM', async () => {
        h = await bootE2E({
          llmTurns: [{ textDeltas: ['ok'], usage: { input: 1, output: 1 } }],
        })
      })

      await when('user sends a message', async () => {
        const { sessionId } = await h!.client.createSession()
        sid = sessionId
        await h!.client.sendInput(sid, 'hello')
      })

      await then('turn completes', async () => {
        await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
      })

      await then('no message has role: system', () => {
        const req = h!.fakeLLM.receivedRequests[0]
        expect(req).toBeDefined()
        const hasSystem = req!.messages.some(m => m.role === 'system')
        expect(hasSystem).toBe(false)
      })
    } finally {
      if (h) await h.stop()
    }
  })

  it('Scenario 11.3: identity ready → no bootstrap marker in systemPrompt', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel with identity ready', async () => {
        h = await bootE2E({
          llmTurns: [{ textDeltas: ['ok'], usage: { input: 1, output: 1 } }],
        })
      })

      await when('user sends a message', async () => {
        const { sessionId } = await h!.client.createSession()
        sid = sessionId
        await h!.client.sendInput(sid, 'hello')
      })

      await then('turn completes', async () => {
        await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
      })

      await then('systemPrompt does NOT contain bootstrap marker', () => {
        const sp = h!.fakeLLM.receivedRequests[0]!.systemPrompt!
        expect(sp).not.toContain('## Bootstrap Pending')
      })
    } finally {
      if (h) await h.stop()
    }
  })
})
