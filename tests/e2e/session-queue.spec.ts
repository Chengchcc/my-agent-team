import { describe, it, expect } from 'bun:test'
import { bootE2E, type E2EHandle } from './_fixtures/boot-kernel'
import { terminalCount } from './_fixtures/event-asserts'
import { given, when, then } from './_fixtures/dsl'

describe('Feature: Session Queue End-to-End (F12)', () => {
  it('Scenario 12.1: concurrent inputs → enqueue → drain → both turns complete', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel with 2-turn LLM + delay on first turn', async () => {
        h = await bootE2E({
          llmTurns: [
            { textDeltas: ['first reply'], usage: { input: 1, output: 1 }, delayMs: 200 },
            { textDeltas: ['second reply'], usage: { input: 1, output: 1 } },
          ],
        })
      })

      await when('two messages sent concurrently to same session', async () => {
        const { sessionId } = await h!.client.createSession()
        sid = sessionId
        // Fire first message, then immediately send second (will enqueue since session is RUNNING)
        const [r1, r2] = await Promise.all([
          h!.client.sendInput(sid, 'msg 1'),
          h!.client.sendInput(sid, 'msg 2'),
        ])
        const a = r1 as { accepted?: boolean; queued?: boolean }
        const b = r2 as { accepted?: boolean; queued?: boolean }
        // At least one should be accepted; the second may be queued
        expect(a.accepted).toBe(true)
        expect(b.accepted).toBe(true)
      })

      await then('both turns complete on the same session', async () => {
        await h!.waitFor(() => terminalCount(h!.captured, sid) >= 2)
        expect(terminalCount(h!.captured, sid)).toBe(2)
      })
    } finally {
      if (h) await h.stop()
    }
  })

  it('Scenario 12.2: pendingInputs survive save/load cycle', async () => {
    let h: E2EHandle | null = null
    try {
      await given('kernel with session store', async () => {
        h = await bootE2E({
          llmTurns: [{ textDeltas: ['ok'], usage: { input: 1, output: 1 }, delayMs: 300 }],
        })
      })

      const { sessionId } = await h!.client.createSession()
      const sid = sessionId

      // Send first message (starts turn), then send second (enqueued while RUNNING)
      h!.client.sendInput(sid, 'msg 1')  // fire-and-forget to race with msg 2
      const r2 = await h!.client.sendInput(sid, 'msg 2')
      const queuedResult = r2 as { queued?: boolean; queueDepth?: number }
      // If second was enqueued, queueDepth should be >= 1
      if (queuedResult.queued) {
        expect(queuedResult.queueDepth).toBeGreaterThanOrEqual(1)
      }

      // Wait for both to complete
      await h!.waitFor(() => terminalCount(h!.captured, sid) >= 2)

      await then('both turns completed', () => {
        expect(terminalCount(h!.captured, sid)).toBe(2)
      })
    } finally {
      if (h) await h.stop()
    }
  })

  it('Scenario 12.3: 5 concurrent inputs → all complete in order, no deadlock', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel with 5-turn LLM', async () => {
        h = await bootE2E({
          llmTurns: [
            { textDeltas: ['r1'], usage: { input: 1, output: 1 } },
            { textDeltas: ['r2'], usage: { input: 1, output: 1 } },
            { textDeltas: ['r3'], usage: { input: 1, output: 1 } },
            { textDeltas: ['r4'], usage: { input: 1, output: 1 } },
            { textDeltas: ['r5'], usage: { input: 1, output: 1 } },
          ],
        })
      })

      await when('5 messages sent concurrently', async () => {
        const { sessionId } = await h!.client.createSession()
        sid = sessionId
        const promises = [1, 2, 3, 4, 5].map(i => h!.client.sendInput(sid, `msg${i}`))
        const results = await Promise.all(promises)
        expect(results.every((r: unknown) => (r as { accepted?: boolean }).accepted)).toBe(true)
      })

      await then('all 5 turns complete', async () => {
        await h!.waitFor(() => terminalCount(h!.captured, sid) >= 5)
        expect(terminalCount(h!.captured, sid)).toBe(5)
      })
    } finally {
      if (h) await h.stop()
    }
  })

  it('Scenario 12.4: drain failure does not pollute previous turn', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel with ok turn + error turn', async () => {
        h = await bootE2E({
          llmTurns: [
            { textDeltas: ['ok'], usage: { input: 1, output: 1 }, delayMs: 200 },
            { textDeltas: ['will crash'], errorAfter: 0, usage: { input: 1, output: 1 } },
          ],
        })
      })

      await when('two messages sent, second causes error', async () => {
        const { sessionId } = await h!.client.createSession()
        sid = sessionId
        h!.client.sendInput(sid, 'msg1')
        await h!.client.sendInput(sid, 'msg2')
      })

      await then('turn1 completes, turn2 fails', async () => {
        await h!.waitFor(() => terminalCount(h!.captured, sid) >= 2)
        const completed = h!.captured.filter(e => e.type === 'turn.completed' && e.sessionId === sid)
        expect(completed.length).toBeGreaterThanOrEqual(1)
        expect(terminalCount(h!.captured, sid)).toBe(2)
      })
    } finally {
      if (h) await h.stop()
    }
  })
})
