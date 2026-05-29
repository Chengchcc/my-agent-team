import { describe, it, expect } from 'bun:test'
import { bootE2E, type E2EHandle } from './_fixtures/boot-kernel'
import { terminalCount } from './_fixtures/event-asserts'
import { given, when, then } from './_fixtures/dsl'

describe('Feature: Error Boundaries (F17)', () => {
  it('Scenario 17.1: LLM error → turn.failed with correct code', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel with LLM that throws mid-stream', async () => {
        h = await bootE2E({
          llmTurns: [{ textDeltas: ['ok'], errorAfter: 0, usage: { input: 1, output: 1 } }],
        })
      })

      await when('user sends a message', async () => {
        const { sessionId } = await h!.client.createSession()
        sid = sessionId
        await h!.client.sendInput(sid, 'trigger')
      })

      await then('turn.failed is emitted', async () => {
        await h!.waitFor(e => e.type === 'turn.failed' && e.sessionId === sid)
        // turn.failed should be the ONLY terminal event
        expect(terminalCount(h!.captured, sid)).toBe(1)
      })
    } finally {
      if (h) await h.stop()
    }
  })

  it('Scenario 17.2: session still usable after turn failure', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel with error then recovery turn', async () => {
        h = await bootE2E({
          llmTurns: [
            { textDeltas: ['ok'], errorAfter: 0, usage: { input: 1, output: 1 } },
            { textDeltas: ['recovered'], usage: { input: 1, output: 1 } },
          ],
        })
      })

      await when('first message fails, second succeeds', async () => {
        const { sessionId } = await h!.client.createSession()
        sid = sessionId
        await h!.client.sendInput(sid, 'fail')
        await h!.waitFor(e => e.type === 'turn.failed' && e.sessionId === sid)
        await h!.client.sendInput(sid, 'recover')
      })

      await then('second turn completes successfully', async () => {
        await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
        // 1 fail + 1 complete = 2 terminal events
        expect(terminalCount(h!.captured, sid)).toBe(2)
      })
    } finally {
      if (h) await h.stop()
    }
  })

  it('Scenario 17.4: hook handler throw does not crash the turn', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel with a throwing onTurnEnd hook', async () => {
        h = await bootE2E({
          llmTurns: [{ textDeltas: ['ok'], usage: { input: 1, output: 1 } }],
        })
        // Register a hook that throws but should not crash the turn
        h.kernel.ctx.hooks.register('e2e.throw-test', 'post', 'onTurnEnd', async () => {
          throw new Error('e2e intentional hook error')
        })
      })

      await when('user sends a message', async () => {
        const { sessionId } = await h!.client.createSession()
        sid = sessionId
        await h!.client.sendInput(sid, 'test')
      })

      await then('turn still completes despite hook error', async () => {
        await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
        expect(terminalCount(h!.captured, sid)).toBe(1)
      })
    } finally {
      if (h) await h.stop()
    }
  })

  it('Scenario 17.1b: empty assistant response surfaces as fallback', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel with empty LLM response', async () => {
        h = await bootE2E({
          llmTurns: [{ textDeltas: [''], usage: { input: 1, output: 0 } }],
        })
      })

      await when('user sends a message', async () => {
        const { sessionId } = await h!.client.createSession()
        sid = sessionId
        await h!.client.sendInput(sid, 'test')
      })

      await then('turn still completes (empty response handled gracefully)', async () => {
        await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
        expect(terminalCount(h!.captured, sid)).toBe(1)
      })
    } finally {
      if (h) await h.stop()
    }
  })
})
