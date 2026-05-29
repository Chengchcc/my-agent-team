import { describe, it, expect } from 'bun:test'
import { bootE2E, type E2EHandle } from './_fixtures/boot-kernel'
import { terminalCount } from './_fixtures/event-asserts'
import { given, when, then } from './_fixtures/dsl'

describe('Feature: Skill Progressive Loading (F15)', () => {
  it('Scenario 15.1: catalog exposes single Skill tool, not N per-skill tools', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel with skills loaded from project dir', async () => {
        h = await bootE2E({
          llmTurns: [{ textDeltas: ['ok'], usage: { input: 1, output: 1 } }],
        })
      })

      await when('user sends a message to trigger resolveTools', async () => {
        const { sessionId } = await h!.client.createSession()
        sid = sessionId
        await h!.client.sendInput(sid, 'test')
      })

      await then('turn completes', async () => {
        await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
        expect(terminalCount(h!.captured, sid)).toBe(1)
      })

      await then('tools array contains Skill (singular)', () => {
        const req = h!.fakeLLM.receivedRequests[0]
        expect(req).toBeDefined()
        expect(req!.tools).toBeDefined()
        const skillTool = req!.tools!.find(t => t.name === 'Skill')
        expect(skillTool).toBeDefined()
        expect(skillTool!.parameters).toHaveProperty('properties.name.enum')
      })

      await then('tools do NOT contain individual skill names', () => {
        const toolNames = h!.fakeLLM.receivedRequests[0]!.tools!.map(t => t.name)
        expect(toolNames).not.toContain('skill-creator')
        expect(toolNames).toContain('Skill')
      })
    } finally {
      if (h) await h.stop()
    }
  })

  it('Scenario 15.2: calling Skill tool triggers tool execution path', async () => {
    let h: E2EHandle | null = null
    let sid = ''
    try {
      await given('kernel + LLM preset that calls Skill tool', async () => {
        h = await bootE2E({
          llmTurns: [
            {
              toolCalls: [{ id: 'tc1', name: 'Skill', arguments: '{"name":"skill-creator"}' }],
              usage: { input: 1, output: 1 },
            },
            { textDeltas: ['I will create a skill now'], usage: { input: 1, output: 1 } },
          ],
        })
      })

      await when('user sends a message', async () => {
        const { sessionId } = await h!.client.createSession()
        sid = sessionId
        await h!.client.sendInput(sid, 'create a skill')
      })

      await then('turn completes after tool roundtrip', async () => {
        await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
        expect(terminalCount(h!.captured, sid)).toBe(1)
      })

      await then('first request has Skill in tools + turn completes normally', () => {
        expect(h!.fakeLLM.receivedRequests[0]!.tools!.some(t => t.name === 'Skill')).toBe(true)
        // Two LLM requests: initial + after tool result
        expect(h!.fakeLLM.receivedRequests.length).toBeGreaterThanOrEqual(2)
      })
    } finally {
      if (h) await h.stop()
    }
  })

  it('Scenario 15.3: Skill enum updates when new skill registered at runtime', async () => {
    let h: E2EHandle | null = null
    try {
      await given('kernel with skills + extra LLM turn', async () => {
        h = await bootE2E({
          llmTurns: [
            { textDeltas: ['ok1'], usage: { input: 1, output: 1 } },
            { textDeltas: ['ok2'], usage: { input: 1, output: 1 } },
          ],
        })
      })

      // Run turn 1 — capture initial enum
      const { sessionId } = await h!.client.createSession()
      await h!.client.sendInput(sessionId, 't1')
      await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sessionId)
      const initEnum = (h!.fakeLLM.receivedRequests[0]!.tools!
        .find(t => t.name === 'Skill')?.parameters as Record<string, unknown>)?.properties as Record<string, { enum?: string[] }> | undefined
      const initSkills = initEnum?.name?.enum ?? []

      // Register a new skill dynamically
      const reg = h!.kernel.ctx.extensions.get('skills.registry') as {
        register(skill: { name: string; description: string; scope: string }): void
      }
      reg.register({ name: 'new-test-skill', description: 'A dynamically added skill', scope: 'agent' })

      // Run turn 2 — verify enum updated
      await h!.client.sendInput(sessionId, 't2')
      await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sessionId)
      const updatedEnum = (h!.fakeLLM.receivedRequests[1]!.tools!
        .find(t => t.name === 'Skill')?.parameters as Record<string, unknown>)?.properties as Record<string, { enum?: string[] }> | undefined
      const updatedSkills = updatedEnum?.name?.enum ?? []

      await then('enum includes the newly registered skill', () => {
        expect(updatedSkills).toContain('new-test-skill')
        expect(updatedSkills.length).toBeGreaterThan(initSkills.length)
      })
    } finally {
      if (h) await h.stop()
    }
  })
})
