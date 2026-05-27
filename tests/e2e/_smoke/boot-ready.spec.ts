import { describe, it, expect, afterEach } from 'bun:test'
import { bootE2E, type E2EHandle } from '../_fixtures/boot-kernel'

describe('PR-1 Smoke: E2E infra boots', () => {
  let h: E2EHandle | null = null
  afterEach(async () => { if (h) await h.stop(); h = null })

  it('bootE2E assembles a real kernel with presets + starts', async () => {
    h = await bootE2E()
    expect(h.kernel.ctx.extensions.list()).toContain('dataplane')
    expect(h.kernel.ctx.extensions.list()).toContain('session')
    expect(h.kernel.ctx.extensions.list().length).toBeGreaterThanOrEqual(9)
  })

  it('inmem transport is reachable + client can call RPC', async () => {
    h = await bootE2E()
    const tools = await h.client.getToolList()
    expect(Array.isArray(tools)).toBe(true)
  })

  it('capture records bus events with sessionId on turn events', async () => {
    h = await bootE2E({
      llmTurns: [{ textDeltas: ['hello from e2e'], usage: { input: 1, output: 1 } }],
    })
    const { sessionId } = await h.client.createSession('smoke')
    await h.client.sendInput(sessionId, 'hi')
    await h.waitFor(e => e.type === 'turn.completed' && e.sessionId === sessionId)
    const deltas = h.captured.filter(e => e.type === 'llm.delta' && e.sessionId === sessionId)
    expect(deltas.length).toBeGreaterThan(0)
    expect(h.captured.filter(e => e.type === 'llm.delta' && !e.sessionId)).toEqual([])
  })
})
