import { describe, it, expect } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
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

  it('Scenario 13.3: bootstrap state survives kernel restart', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'e2e-bs-persist-'))
    try {
      // Write a bootstrap.md with pre-existing state (2 turns completed)
      const bootstrapPath = path.join(agentDir, 'identity', 'bootstrap.md')
      await require('node:fs/promises').mkdir(path.dirname(bootstrapPath), { recursive: true })
      await require('node:fs/promises').writeFile(bootstrapPath, `---
status: pending
turns_completed: 2
turns_max: 6
required_fields: ["role","audience","tone","expertise","constraints"]
collected: {"role":"backend","audience":"devs"}
stall_count: 0
---

# Agent Identity Bootstrap
`)

      const h = await bootE2E({
        preExistingAgentDir: agentDir,
        llmTurns: [{ textDeltas: ['Q3: tone?'], usage: { input: 1, output: 1 } }],
      })
      h.fakeLLM.setInvokeResponses([
        { content: '{"tone":"professional"}', usage: { input: 0, output: 0 } },
      ])

      // Set pending_bootstrap so transformPrompt enters bootstrap mode
      const agentStore = h.kernel.ctx.extensions.get('agent.store') as InMemoryAgentStore
      await agentStore.update('e2e', { identityStatus: 'pending_bootstrap', identityPath: '' })

      // Run a turn — preTurnAbsorb should see turnsCompleted=2 and extract field 3
      const { sessionId } = await h.client.createSession()
      await h.client.sendInput(sessionId, 'professional tone')
      await h.waitFor(e => e.type === 'turn.completed' && e.sessionId === sessionId)

      // Verify bootstrap.md was updated
      const updated = readFileSync(bootstrapPath, 'utf-8')
      expect(updated).toContain('turns_completed: 3')
      expect(updated).toContain('"tone"')

      await h.stop()
    } finally {
      await rm(agentDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('Scenario 13.4: RUNNING session auto-downgraded to IDLE on restart', async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), 'e2e-runningfix-'))
    try {
      // Boot once, get session RUNNING, then crash (no clean stop)
      let h = await bootE2E({
        preExistingAgentDir: agentDir,
        llmTurns: [{ textDeltas: ['ok'], usage: { input: 1, output: 1 }, delayMs: 200 }],
      })
      const { sessionId } = await h.client.createSession()
      h.client.sendInput(sessionId, 'msg') // fire-and-forget — makes session RUNNING
      // Force kill without clean stop (don't await turn completion)
      await h.kernel.stop() // hard stop while RUNNING
      h = null as unknown as E2EHandle

      // Boot new kernel with same agentDir — RUNNING session should be downgraded
      h = await bootE2E({
        preExistingAgentDir: agentDir,
        llmTurns: [{ textDeltas: ['recovered'], usage: { input: 1, output: 1 } }],
      })

      // New message should work — no "invalid transition" crash
      const { sessionId: sid2 } = await h.client.createSession()
      await h.client.sendInput(sid2, 'after restart')
      await h.waitFor(e => e.type === 'turn.completed' && e.sessionId === sid2)

      await then('turn completes after restart with downgraded session', () => {
        expect(terminalCount(h!.captured, sid2)).toBe(1)
      })

      await h.stop()
    } finally {
      await rm(agentDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
