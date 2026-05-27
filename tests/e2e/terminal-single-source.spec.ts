import { describe, it, expect, afterEach } from 'bun:test'
import { bootE2E, type E2EHandle } from './_fixtures/boot-kernel'
import { terminalCount } from './_fixtures/event-asserts'
import { given, when, then } from './_fixtures/dsl'

describe('Feature: Single source of truth for terminal events (F9)', () => {
  let h: E2EHandle | null = null
  afterEach(async () => { if (h) await h.stop(); h = null })

  it('Scenario 9.1: Given a text-only turn, When it completes, Then exactly ONE turn.completed per turn with non-undefined sessionId/turnId', async () => {
    let sid = ''

    await given('kernel with single text delta', async () => {
      h = await bootE2E({
        llmTurns: [{ textDeltas: ['reply'], usage: { input: 1, output: 1 } }],
      })
    })

    await when('user sends input', async () => {
      const { sessionId } = await h!.client.createSession()
      sid = sessionId
      await h!.client.sendInput(sid, 'hi')
    })

    await then('exactly one terminal event', async () => {
      await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
      expect(terminalCount(h!.captured, sid)).toBe(1)
    })

    await then('terminal envelope has non-undefined sessionId and turnId', () => {
      const terminal = h!.captured.find(e => e.type === 'turn.completed' && e.sessionId === sid)
      expect(terminal).toBeDefined()
      expect(terminal!.sessionId).toBe(sid)
      expect(terminal!.turnId).toBeDefined()
      expect(typeof terminal!.turnId).toBe('string')
    })
  })

  it('Scenario 9.1b: Given a failing turn, When it fails, Then exactly ONE turn.failed (no shadow turn.completed)', async () => {
    let sid = ''

    await given('kernel with errorAfter=0', async () => {
      h = await bootE2E({
        llmTurns: [{ textDeltas: ['boom'], errorAfter: 0, usage: { input: 0, output: 0 } }],
      })
    })

    await when('user sends input that triggers error', async () => {
      const { sessionId } = await h!.client.createSession()
      sid = sessionId
      await h!.client.sendInput(sid, 'hi')
    })

    await then('exactly one turn.failed, zero turn.completed', async () => {
      await h!.waitFor(e => e.type === 'turn.failed' && e.sessionId === sid)
      expect(terminalCount(h!.captured, sid)).toBe(1)
      expect(h!.captured.filter(e => e.type === 'turn.completed' && e.sessionId === sid)).toHaveLength(0)
    })
  })
})
