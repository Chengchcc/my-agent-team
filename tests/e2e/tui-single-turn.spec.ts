import { describe, it, expect } from 'bun:test'
import { bootE2E, type E2EHandle } from './_fixtures/boot-kernel'
import { assistantText, terminalCount, eventsWithoutSessionId } from './_fixtures/event-asserts'
import { given, when, then } from './_fixtures/dsl'

describe('Feature: TUI single-turn (F2)', () => {
  it('Scenario 2.1: Given a kernel with single-delta LLM, When user types "hi", Then reply renders + exactly one turn.completed', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel with single text delta', async () => {
        h = await bootE2E({
          llmTurns: [{ textDeltas: ['hello back'], usage: { input: 1, output: 2 } }],
        })
      })

      await when('user creates session and types "hi"', async () => {
        const { sessionId } = await h!.client.createSession('e2e')
        sid = sessionId
        await h!.client.sendInput(sid, 'hi')
      })

      await then('assistant reply equals "hello back"', async () => {
        await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
        expect(assistantText(h!.captured, sid)).toBe('hello back')
      })

      await then('exactly one turn.completed was emitted', () => {
        expect(terminalCount(h!.captured, sid)).toBe(1)
      })

      await then('no per-session event is missing sessionId on envelope', () => {
        expect(eventsWithoutSessionId(h!.captured, 'llm.')).toEqual([])
        expect(eventsWithoutSessionId(h!.captured, 'turn.')).toEqual([])
      })
    } finally {
      if (h) await h.stop()
    }
  })

  it('Scenario 2.2: Given LLM streaming 3 deltas, When user sends input, Then deltas concatenate in order', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel with 3 text deltas', async () => {
        h = await bootE2E({
          llmTurns: [{ textDeltas: ['hel', 'lo ', 'back'], usage: { input: 1, output: 3 } }],
        })
      })

      await when('user sends "hi"', async () => {
        const { sessionId } = await h!.client.createSession()
        sid = sessionId
        await h!.client.sendInput(sid, 'hi')
      })

      await then('3 deltas arrive and concatenate to "hello back"', async () => {
        await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
        const deltas = h!.captured.filter(e => e.type === 'llm.delta' && e.sessionId === sid)
        expect(deltas.length).toBeGreaterThanOrEqual(3)
        expect(assistantText(h!.captured, sid)).toBe('hello back')
      })
    } finally {
      if (h) await h.stop()
    }
  })

  it('Scenario 2.3: Given LLM throws at 2nd chunk, When user sends input, Then exactly one turn.failed (no turn.completed)', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel with errorAfter=1', async () => {
        h = await bootE2E({
          llmTurns: [{ textDeltas: ['ok', 'boom'], errorAfter: 1, usage: { input: 1, output: 1 } }],
        })
      })

      await when('user sends "hi"', async () => {
        const { sessionId } = await h!.client.createSession()
        sid = sessionId
        await h!.client.sendInput(sid, 'hi')
      })

      await then('exactly one turn.failed, zero turn.completed', async () => {
        await h!.waitFor(e => e.type === 'turn.failed' && e.sessionId === sid)
        expect(h!.captured.filter(e => e.type === 'turn.completed' && e.sessionId === sid)).toHaveLength(0)
        expect(h!.captured.filter(e => e.type === 'turn.failed' && e.sessionId === sid)).toHaveLength(1)
      })
    } finally {
      if (h) await h.stop()
    }
  })
})
