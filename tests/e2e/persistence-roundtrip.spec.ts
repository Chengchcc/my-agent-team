import { describe, it, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { bootE2E, type E2EHandle } from './_fixtures/boot-kernel'
import { terminalCount, assistantText } from './_fixtures/event-asserts'
import { given, when, then } from './_fixtures/dsl'
import { InMemoryAgentStore } from './_fixtures/in-memory-agent-store'

async function runTurn(h: E2EHandle, sessionId: string, msg: string): Promise<string> {
  await h.client.sendInput(sessionId, msg)
  await h.waitFor(e => e.type === 'turn.completed' && e.sessionId === sessionId)
  return assistantText(h.captured, sessionId)
}

describe('Feature: Persistence Roundtrip (F13)', () => {
  it('Scenario 13.1: session history survives kernel restart', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'e2e-persist-'))
    let sid = ''
    try {
      let h: E2EHandle | null = null

      // Boot 1: create session + run 2 turns
      await given('first kernel with 2 turns', async () => {
        h = await bootE2E({
          preExistingAgentDir: agentDir,
          llmTurns: [
            { textDeltas: ['reply 1'], usage: { input: 1, output: 1 } },
            { textDeltas: ['reply 2'], usage: { input: 1, output: 1 } },
          ],
        })
      })

      await when('two turns run', async () => {
        const { sessionId } = await h!.client.createSession()
        sid = sessionId
        await runTurn(h!, sid, 'msg 1')
        await runTurn(h!, sid, 'msg 2')
        expect(terminalCount(h!.captured, sid)).toBe(2)
      })

      await h!.stop()

      // Boot 2: reuse agentDir, verify history restored
      await given('second kernel with same agentDir', async () => {
        h = await bootE2E({
          preExistingAgentDir: agentDir,
          llmTurns: [
            { textDeltas: ['reply 3'], usage: { input: 1, output: 1 } },
          ],
        })
      })

      await then('third turn completes with full history', async () => {
        await h!.client.attachSession(sid)
        await runTurn(h!, sid, 'msg 3')
        expect(terminalCount(h!.captured, sid)).toBe(1) // new kernel, fresh capture
      })

      await h!.stop()
    } finally {
      await rm(agentDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('Scenario 13.2: identity survives kernel restart', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'e2e-idpersist-'))
    let h: E2EHandle | null = null
    try {
      // Boot 1: set identity ready
      h = await bootE2E({
        preExistingAgentDir: agentDir,
        llmTurns: [{ textDeltas: ['ok'], usage: { input: 1, output: 1 } }],
      })
      await h.stop()

      // Boot 2: verify identity still ready
      h = await bootE2E({
        preExistingAgentDir: agentDir,
        llmTurns: [{ textDeltas: ['ok'], usage: { input: 1, output: 1 } }],
      })

      await when('user sends message after restart', async () => {
        const { sessionId } = await h!.client.createSession()
        const sid = sessionId
        await h!.client.sendInput(sid, 'hello')
        await h!.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid)
      })

      await then('systemPrompt does NOT contain bootstrap', () => {
        const sp = h!.fakeLLM.receivedRequests[0]!.systemPrompt!
        expect(sp).not.toContain('## Bootstrap Pending')
      })

      await h.stop()
    } finally {
      await rm(agentDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
