import { describe, it, expect, beforeAll } from 'bun:test'
import { bootE2E, type E2EHandle } from './_fixtures/boot-kernel'
import { terminalCount } from './_fixtures/event-asserts'
import { given, when, then } from './_fixtures/dsl'
import { InMemoryAgentStore } from './_fixtures/in-memory-agent-store'

describe('Feature: Identity Bootstrap State Machine (F10)', () => {
  it('Scenario 10.5: bootstrap pending → systemPrompt starts with Bootstrap Pending', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel with identity pending_bootstrap', async () => {
        h = await bootE2E({
          llmTurns: [{ textDeltas: ['你的角色定位是什么？'], usage: { input: 1, output: 1 } }],
        })
        // Set agent to pending_bootstrap so transformPrompt enters bootstrap mode
        const agentStore = h!.kernel.ctx.extensions.get('agent.store') as InMemoryAgentStore
        await agentStore.update('e2e', { identityStatus: 'pending_bootstrap', identityPath: '' })
      })

      await when('user sends first bootstrap message', async () => {
        const { sessionId } = await h!.client.createSession()
        sid = sessionId
        await h!.client.sendInput(sid, '你好')
      })

      await then('turn completes', async () => {
        await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
        expect(terminalCount(h!.captured, sid)).toBe(1)
      })

      await then('systemPrompt starts with Bootstrap Pending', () => {
        const sp = h!.fakeLLM.receivedRequests[0]!.systemPrompt!
        expect(sp).toContain('## Bootstrap Pending')
        // Bootstrap supplement should be at the start of the prompt (prepended, not appended)
        expect(sp.indexOf('## Bootstrap Pending')).toBeLessThan(sp.indexOf('## Available Skills'))
      })
    } finally {
      if (h) await h.stop()
    }
  })

  it('Scenario 10.6: identity ready → systemPrompt does NOT contain bootstrap', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel with identity ready (default)', async () => {
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

      await then('systemPrompt does NOT contain Bootstrap Pending', () => {
        const sp = h!.fakeLLM.receivedRequests[0]!.systemPrompt!
        expect(sp).not.toContain('## Bootstrap Pending')
      })
    } finally {
      if (h) await h.stop()
    }
  })

  it('Scenario 10.1: bootstrap happy path — 3 fields collected → finalize', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel with pending_bootstrap + pre-seeded 5 LLM turns for 5 questions', async () => {
        h = await bootE2E({
          llmTurns: [
            { textDeltas: ['Q1: role?'], usage: { input: 1, output: 1 } },
            { textDeltas: ['Q2: audience?'], usage: { input: 1, output: 1 } },
            { textDeltas: ['Q3: tone?'], usage: { input: 1, output: 1 } },
            { textDeltas: ['Q4: expertise?'], usage: { input: 1, output: 1 } },
            { textDeltas: ['Q5: constraints?'], usage: { input: 1, output: 1 } },
          ],
        })
        // 5 extracts + 1 synthesize
        h!.fakeLLM.setInvokeResponses([
          { content: '{"role":"backend"}', usage: { input: 0, output: 0 } },
          { content: '{"audience":"devs"}', usage: { input: 0, output: 0 } },
          { content: '{"tone":"pro"}', usage: { input: 0, output: 0 } },
          { content: '{"expertise":"TS"}', usage: { input: 0, output: 0 } },
          { content: '{"constraints":"CN"}', usage: { input: 0, output: 0 } },
          { content: '---\nrole: backend\naudience: devs\ntone: pro\n---\n\nIdentity body.', usage: { input: 0, output: 0 } },
        ])
        const agentStore = h!.kernel.ctx.extensions.get('agent.store') as InMemoryAgentStore
        await agentStore.update('e2e', { identityStatus: 'pending_bootstrap', identityPath: '' })
      })

      const answers = [
        'backend dev', 'team devs', 'professional', 'TypeScript', 'Chinese only',
      ]

      // Turn 1: initial → extract skipped by preTurnAbsorb
      await when('user sends initial message', async () => {
        const { sessionId } = await h!.client.createSession()
        sid = sessionId
        await h!.client.sendInput(sid, 'hello')
      })

      for (let i = 0; i < answers.length; i++) {
        await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
        await h!.client.sendInput(sid, answers[i]!)
      }

      await then('6 turns complete (initial + 5 answers)', async () => {
        await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
        expect(terminalCount(h!.captured, sid)).toBe(6)
      })

      await then('agent identityStatus is ready after finalize', async () => {
        const agentStore = h!.kernel.ctx.extensions.get('agent.store') as InMemoryAgentStore
        const agent = await agentStore.get('e2e')
        expect(agent!.identityStatus).toBe('ready')
      })
    } finally {
      if (h) await h.stop()
    }
  })
})
