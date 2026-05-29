import { describe, it, expect } from 'bun:test'
import { bootE2E, type E2EHandle } from './_fixtures/boot-kernel'
import { terminalCount } from './_fixtures/event-asserts'
import { given, when, then } from './_fixtures/dsl'

describe('Feature: Trace Completeness (F16)', () => {
  it('Scenario 16.1: llm.request captured with system + messages', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel with single-turn LLM', async () => {
        h = await bootE2E({
          llmTurns: [{ textDeltas: ['hello'], usage: { input: 1, output: 1 } }],
        })
      })

      await when('user sends a message', async () => {
        const { sessionId } = await h!.client.createSession()
        sid = sessionId
        await h!.client.sendInput(sid, 'test')
      })

      await then('turn completes', async () => {
        await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
        expect(terminalCount(h!.captured, sid)).toBe(1)
      })

      await then('llm.request has non-empty systemPrompt', () => {
        const req = h!.fakeLLM.receivedRequests[0]!
        expect(req.systemPrompt).toBeTruthy()
        expect(req.systemPrompt!.length).toBeGreaterThan(0)
      })

      await then('llm.request has non-empty messages', () => {
        const req = h!.fakeLLM.receivedRequests[0]!
        expect(req.messages.length).toBeGreaterThan(0)
        expect(req.messages.every(m => typeof m.content === 'string')).toBe(true)
      })
    } finally {
      if (h) await h.stop()
    }
  })

  it('Scenario 16.2: trace events include turn lifecycle', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel with tool call turn', async () => {
        h = await bootE2E({
          fakeTools: [{ name: 'echo', handler: (args) => `echo: ${JSON.stringify(args)}` }],
          llmTurns: [
            {
              toolCalls: [{ id: 't1', name: 'echo', arguments: '{"msg":"hi"}' }],
              usage: { input: 1, output: 1 },
            },
            { textDeltas: ['done'], usage: { input: 1, output: 1 } },
          ],
        })
      })

      await when('user triggers a tool-turn', async () => {
        const { sessionId } = await h!.client.createSession()
        sid = sessionId
        await h!.client.sendInput(sid, 'echo hi')
      })

      await then('turn completes', async () => {
        await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
      })

      await then('turn.started + turn.completed events exist', () => {
        const started = h!.captured.filter(e => e.type === 'turn.started' && e.sessionId === sid)
        expect(started.length).toBeGreaterThanOrEqual(1)
        const completed = h!.captured.filter(e => e.type === 'turn.completed' && e.sessionId === sid)
        expect(completed.length).toBe(1)
      })

      await then('tool.executed events captured', () => {
        const toolEvents = h!.captured.filter(e => e.type === 'tool.executed')
        expect(toolEvents.length).toBeGreaterThanOrEqual(1)
      })
    } finally {
      if (h) await h.stop()
    }
  })

  it('Scenario 16.3: trace DB persists events after turn', async () => {
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
        await h!.client.sendInput(sid, 'test')
      })

      await then('turn completes', async () => {
        await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
      })

      await then('trace reader can list recent runs', async () => {
        const reader = h!.kernel.ctx.extensions.get('trace.reader') as {
          listRecentRuns(opts: { limit: number }): Promise<Array<{ id: string; totalTurns: number }>>
        }
        const runs = await reader.listRecentRuns({ limit: 5 })
        expect(runs.length).toBeGreaterThanOrEqual(1)
        expect(runs[0]!.totalTurns).toBeGreaterThanOrEqual(1)
      })
    } finally {
      if (h) await h.stop()
    }
  })
})
